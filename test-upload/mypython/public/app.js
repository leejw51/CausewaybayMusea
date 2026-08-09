/* Aperture — resumable chunked uploader + gallery.
 *
 * Shared verbatim by the rust (8701), python (8702) and typescript (8703)
 * backends so the three can be compared byte-for-byte on the same client code.
 *
 * Upload protocol (identical on all three servers):
 *   POST   /api/upload/init            {id,name,size,type} -> {id, received, chunkSize}
 *   GET    /api/upload/{id}/status                         -> {received}
 *   PUT    /api/upload/{id}?offset=N   <raw bytes>          -> {received}
 *   POST   /api/upload/{id}/complete                        -> {item}
 *   DELETE /api/upload/{id}                                 -> abort, drop partial
 *
 * Notes for the iPhone / Tailscale case this exists to test:
 *  - no crypto.subtle: plain http over a 100.x address is not a secure context,
 *    so the resume key is a pure-JS FNV-1a hash of name|size|type plus a
 *    128 KB head probe. Deliberately NOT lastModified — see keyFor().
 *  - XHR (not fetch) because only XHR reports upload progress.
 *  - chunk size adapts to measured throughput, so a slow link stays responsive
 *    and a fast one stops paying per-request overhead.
 */

'use strict';

// 1 TB per file. Nothing on either side ever holds a whole file: the client
// reads and sends one small chunk at a time, the server streams each chunk
// straight into the .part file. Size is bounded by disk, not memory.
const MAX_BYTES = 1024 * 1024 * 1024 * 1024;
// Fixed 500 KB chunks — no adaptation, no growth. On a lossy path
// (phone → VPN → mac) a lost reply costs the whole chunk, and iOS kills pages
// holding large pending uploads, so the chunk stays small enough that losing
// one is cheap and a retry is instant, while keeping the request count for a
// very large file sane. A 1 TB file is simply a lot of these.
const MIN_CHUNK = 500 * 1024;
const MAX_CHUNK = 500 * 1024;
const START_CHUNK = 500 * 1024;
const TARGET_CHUNK_SECONDS = 2.5; // aim for a progress tick every ~2.5s
const MAX_RETRIES = 8;

// A Tailscale DERP-relayed link can go quiet mid-chunk without dropping the
// socket, so "no bytes moved" is the only reliable signal that it is wedged.
// Without these the transfer just sits there until HARD_TIMEOUT_MS and looks
// permanently frozen to the user.
// An upload has two phases and they fail differently:
//   sending   — xhr.upload.onprogress fires; silence here means a wedged link
//   awaiting  — body fully handed to the OS, waiting for the server's reply.
//               NO progress events fire in this phase, so it must not be
//               mistaken for a stall: the bytes may already be on the server,
//               and aborting throws away work and re-sends it.
const STALL_WARN_MS = 8000;       // sending: went quiet, warn the user
const STALL_ABORT_MS = 30000;     // sending: give up and retry the chunk
const RESPONSE_WARN_MS = 8000;    // awaiting: slow reply, say so
const RESPONSE_GRACE_MS = 15000;  // awaiting: assume the reply is lost
const PROBE_AFTER_MS = 2500;      // awaiting: start asking the server directly
const HARD_TIMEOUT_MS = 300000;

// iOS Safari needs special handling: Photos-picked video Files are backed by
// temp exports whose lazy slice reads can hang or die silently, and huge
// chunks make that worse.
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MAX_CHUNK_EFF = MAX_CHUNK; // same small-chunk policy everywhere

const $ = (id) => document.getElementById(id);

/* ── on-page debug log (phones have no console) ────────
 *
 * The on-page panel is always live: it is local, free, and the only console a
 * phone has. Relaying every line to the server and mirroring it through
 * localStorage is not free — one POST and one JSON round-trip through
 * localStorage per line, which during a large upload is thousands of extra
 * requests on the same link the upload needs. Those two are the forensics
 * that found the stall bugs, so they stay one URL away rather than deleted:
 *
 *     http://host:8701/?debug=1     ← turn on, sticky across reloads
 *     http://host:8701/?debug=0     ← turn off
 *
 * Sticky matters: the pages worth investigating are the ones that reload
 * themselves mid-upload, and a query param would not survive that.
 */
const DEBUG = (() => {
  try {
    const q = new URLSearchParams(location.search).get('debug');
    if (q !== null) {
      if (q === '0' || q === 'false') localStorage.removeItem('aperture.debug');
      else localStorage.setItem('aperture.debug', '1');
    }
    return localStorage.getItem('aperture.debug') === '1';
  } catch (_) { return false; }
})();

const dbuf = [];
function dlog(msg) {
  const line = new Date().toTimeString().slice(0, 8) + ' ' + msg;
  if (DEBUG) {
    // mirror to the server so phone-side stalls appear in its log timeline
    try { fetch('/api/dlog', { method: 'POST', body: line, keepalive: true }).catch(() => {}); } catch (_) {}
    // and to localStorage: when the page dies mid-upload the in-flight relay
    // lines are lost, so the next incarnation replays these and the server
    // log shows the previous page's final moments (see replayPrevLog)
    try {
      const ring = JSON.parse(localStorage.getItem('dlogRing') || '[]');
      ring.push(line);
      localStorage.setItem('dlogRing', JSON.stringify(ring.slice(-60)));
    } catch (_) {}
  }
  dbuf.push(line);
  if (dbuf.length > 300) dbuf.shift();
  const pre = document.getElementById('dbgLog');
  if (pre) {
    pre.textContent = dbuf.join('\n');
    pre.scrollTop = pre.scrollHeight;
  }
}

function replayPrevLog() {
  if (!DEBUG) return;
  try {
    const ring = JSON.parse(localStorage.getItem('dlogRing') || '[]');
    localStorage.removeItem('dlogRing');
    if (!ring.length) return;
    const nav = (performance.getEntriesByType('navigation')[0] || {}).type || '?';
    const body = `── previous page (this load: ${nav}) ──\n` + ring.map((l) => 'prev| ' + l).join('\n');
    fetch('/api/dlog', { method: 'POST', body }).catch(() => {});
  } catch (_) {}
}

function mountDebugPanel() {
  const foot = document.querySelector('.foot');
  if (!foot || document.getElementById('dbgWrap')) return;
  const d = document.createElement('details');
  d.id = 'dbgWrap';
  d.innerHTML = '<summary>debug log</summary><pre id="dbgLog"></pre>';
  d.querySelector('pre').style.cssText =
    'text-align:left;max-height:40vh;overflow:auto;background:rgba(0,0,0,.5);' +
    'padding:10px;border-radius:8px;font-size:10.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all;';
  d.style.cssText = 'margin-top:12px;cursor:pointer;';
  foot.appendChild(d);
  dlog(`ua: ${navigator.userAgent}`);
  dlog(`ios=${IS_IOS} maxChunk=${fmtBytes(MAX_CHUNK_EFF)}`);
}

/* ── timeouts: nothing on a phone may block forever ──── */

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label || 'operation'} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/* ── screen wake lock: a locked iPhone freezes JS ────── */

let wakeLock = null;
let sleepVideo = null;   // NoSleep fallback: wakeLock needs HTTPS, this page is plain http

function sleepBlockerVideo() {
  if (sleepVideo) return sleepVideo;
  const v = document.createElement('video');
  v.setAttribute('playsinline', '');
  v.muted = true;
  v.loop = true;
  v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;left:0;top:0;';
  v.src = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANNbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAnd0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAIAAAACAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAHvbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAKABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABmm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAVpzdGJsAAAAunN0c2QAAAAAAAAAAQAAAKphdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAIAAgBIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAMGF2Y0MBQsAK/+EAGGdCwArZH4iIwEQAAAMABAAAAwBQPEiZIAEABWjLg8sgAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAFqgAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAoAAAQAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAoAAAABAAAAPHN0c3oAAAAAAAAAAAAAAAoAAAKDAAAACQAAAAoAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAAFHN0Y28AAAAAAAAAAQAAA30AAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYyLjEyLjEwMgAAAAhmcmVlAAAC3W1kYXQAAAJxBgX//23cRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xMCBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAApliIQP8mKAAMPuAAAABUGaOB/qAAAABkGaVAf6gAAAAAVBmmA/1AAAAAVBmoA/1AAAAAVBmqA/1AAAAAVBmsA/1AAAAAVBmuA/1AAAAAVBmwA71AAAAAVBmyA31A==';
  document.body.appendChild(v);
  sleepVideo = v;
  return v;
}

async function keepAwake(on) {
  // Preferred: the real Screen Wake Lock API (secure contexts only).
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
      dlog('wake lock acquired');
      return;
    }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { dlog('wake lock unavailable: ' + e.message); }
  // Fallback for http://: iOS keeps the screen on while a video is playing.
  // An auto-locked iPhone freezes ALL JS, which shows up as bursts of chunks
  // whenever the user touches the phone and ~45s silences in between.
  try {
    const v = sleepBlockerVideo();
    if (on && v.paused) {
      await v.play();
      dlog('keep-awake video playing (auto-lock suppressed)');
    } else if (!on && !v.paused) {
      v.pause();
      dlog('keep-awake video stopped');
    }
  } catch (e) { dlog('keep-awake video refused: ' + e.message); }
}

// Set while the tab is tearing down, so a chunk that dies because the page is
// going away can be told apart from one the network actually killed.
let pageUnloading = false;

/* Safari does not kill this page on navigation — it parks it, JS state and
 * all, in the back-forward cache (the log showed pagehide persisted=true) and
 * can resurrect it later. A resurrected page still has its Transfer loops and
 * in-flight XHRs, so it starts uploading again IN PARALLEL with the live
 * page: two uploaders race on the same upload id, trade 409s, thrash the
 * offset, and the visible transfer grinds to a halt. That — not the network —
 * is what froze uploads until a manual refresh.
 *
 * So: on the way out, silence every transfer this instance owns. And if the
 * page comes back from the bfcache, reload — a fresh boot restores the queue
 * from IndexedDB and resumes at the server's offset, with no zombie state.
 */
window.addEventListener('pagehide', (e) => {
  pageUnloading = true;
  dlog(`pagehide persisted=${e.persisted}`);
  // release the cross-tab uploader beat if it is ours, so the next page
  // (usually our own refresh) restores the queue immediately instead of
  // waiting out a heartbeat from a tab that no longer exists
  try {
    const beat = JSON.parse(localStorage.getItem('uploaderBeat') || 'null');
    if (beat && beat.tab === TAB_ID) localStorage.removeItem('uploaderBeat');
  } catch (_) {}
  for (const t of state.queue) {
    if (t.status === 'uploading' || t.status === 'queued') {
      t.status = 'paused';
      try { if (t.xhr) t.xhr.abort(); } catch (_) {}
      t.closeStream();
    }
  }
  state.active = null;
});

window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    dlog('resurrected from bfcache — reloading for a clean uploader');
    location.reload();
  }
});

document.addEventListener('visibilitychange', () => {
  dlog('visibility: ' + document.visibilityState);
  if (document.visibilityState !== 'visible') return;
  if (state.active) keepAwake(true);
  // Coming back to the foreground is the single strongest signal that a
  // transfer iOS froze can be picked up again. reviveStalled is defined below;
  // this handler only ever runs long after the module has finished evaluating.
  reviveStalled('back in the foreground');
});

/* ── the queue survives page reloads ─────────────────────
 * iOS kills sockets on backgrounding and often reloads the whole tab on
 * return, which silently wiped the in-memory queue: every multi-chunk file
 * died at its second chunk while single-chunk photos survived. Files are
 * structured-cloneable, so the queue lives in IndexedDB and boot() re-enqueues
 * whatever a previous incarnation of this page did not finish.
 */
const store = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const rq = indexedDB.open('aperture-queue', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('pending', { keyPath: 'id' });
      rq.onsuccess = () => { this.db = rq.result; resolve(this.db); };
      rq.onerror = () => reject(rq.error);
    });
  },
  async put(rec) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      tx.objectStore('pending').put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  async del(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pending', 'readwrite');
      tx.objectStore('pending').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  async all() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const rq = db.transaction('pending').objectStore('pending').getAll();
      rq.onsuccess = () => resolve(rq.result || []);
      rq.onerror = () => reject(rq.error);
    });
  },
};

function unpersist(id) {
  store.del(id).catch((e) => dlog('queue unpersist failed: ' + e.message));
}

const els = {
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  queue: $('queue'),
  queueList: $('queueList'),
  queueSummary: $('queueSummary'),
  clearDone: $('clearDone'),
  grid: $('grid'),
  empty: $('empty'),
  statCount: $('statCount'),
  statSize: $('statSize'),
  statNet: $('statNet'),
  backendBadge: $('backendBadge'),
  backendName: $('backendName'),
  dragVeil: $('dragVeil'),
  lightbox: $('lightbox'),
  lbStage: $('lbStage'),
  lbCaption: $('lbCaption'),
  lbClose: $('lbClose'),
  lbPrev: $('lbPrev'),
  lbNext: $('lbNext'),
};

const state = {
  items: [],
  filter: 'all',
  queue: [],       // Transfer[]
  active: null,    // Transfer currently on the wire
  lbIndex: -1,
};

/* ── helpers ─────────────────────────────────────────── */

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}

function fmtRate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '—';
  return fmtBytes(bps) + '/s';
}

function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec < 0 || sec > 86400 * 7) return '—';
  sec = Math.round(sec);
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return m + 'm ' + String(s).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}

// FNV-1a over the resume key; works without a secure context.
function hashKey(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

// Same FNV-1a, over bytes rather than a string.
function hashBytes(bytes) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

const PROBE_BYTES = 128 * 1024;

/* The resume key.
 *
 * This used to be hash(name|size|lastModified), which quietly broke resume on
 * iOS. Picking a video out of Photos makes Safari export the asset to a temp
 * file, and lastModified is the time of *that export*, not the capture date.
 * So re-picking the very same video yields a fresh mtime -> a fresh id -> the
 * server has no .part under it -> the upload restarts at 0. That is also why
 * the "pick the same file again to resume" recovery path never actually
 * resumed.
 *
 * Hash a head probe instead. The same footage keys the same upload no matter
 * how many times iOS re-exports it, while two different files that happen to
 * share a name and byte size still get distinct ids. If the probe cannot be
 * read we fall back to name|size|type, which is weaker but still stable.
 */
async function keyFor(file) {
  const base = [file.name, file.size, file.type || ''].join('|');
  try {
    const head = file.slice(0, Math.min(PROBE_BYTES, file.size));
    const buf = new Uint8Array(await withTimeout(head.arrayBuffer(), 20000, 'reading the file header'));
    if (!buf.byteLength) throw new Error('empty probe');
    return hashKey(base + '|' + hashBytes(buf));
  } catch (e) {
    dlog(`probe read failed (${e.message}) — keying on name|size|type only`);
    return hashKey(base);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function kindOf(type, name) {
  if (type && type.startsWith('video/')) return 'video';
  if (type && type.startsWith('image/')) return 'image';
  return /\.(mp4|mov|m4v|webm|avi|mkv|hevc)$/i.test(name || '') ? 'video' : 'image';
}

function toast(msg, isErr) {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  host.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, isErr ? 5200 : 2800);
}

async function api(path, opts) {
  // Always bounded: a hung fetch here silently freezes the retry loop.
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  let res;
  try {
    res = await fetch(path, { ...(opts || {}), signal: ctl.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `request to ${path} timed out` : e.message);
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); if (j && j.error) detail = j.error; } catch (_) {}
    throw new Error(detail || ('HTTP ' + res.status));
  }
  return res.status === 204 ? null : res.json();
}

/* ── transfer ────────────────────────────────────────── */

class Transfer {
  constructor(file, id) {
    this.file = file;
    this.name = file.name;
    this.size = file.size;
    this.type = file.type || '';
    this.kind = kindOf(this.type, this.name);
    this.id = id; // from keyFor(), or replayed from IndexedDB on restore
    this.sent = 0;
    this.chunk = START_CHUNK;
    this.status = 'queued'; // queued|uploading|paused|done|error|cancelled
    this.error = '';
    this.fatal = false;     // error that reviving cannot fix (unreadable file)
    this.stalled = false;   // false | 'sending' | 'awaiting'
    this.abortedWhileAwaiting = false;
    this.reader = null;     // sequential stream reader (see openStream)
    this.streamPos = 0;
    this.carry = null;
    this.attempt = 0;
    this.rate = 0;          // smoothed bytes/sec
    this.xhr = null;
    this.startedAt = 0;
    this.el = null;
    this.render();
  }

  get pct() { return this.size ? Math.min(100, (this.sent / this.size) * 100) : 0; }

  /* ── sequential file reader ─────────────────────────
   * iOS Safari backs Photos-picked media with a provider proxy: the FIRST
   * read succeeds, and every later random-access slice() read can hang
   * forever. A single forward pass over file.stream() only ever opens the
   * file once, which sidesteps that entirely. slice() remains as the
   * fallback for browsers without Blob.stream().
   */

  closeStream() {
    if (this.reader) { try { this.reader.cancel(); } catch (_) {} }
    this.reader = null;
    this.streamPos = 0;   // absolute offset of the next byte the reader yields
    this.carry = null;    // bytes read but not yet handed out
  }

  async openStream(fromOffset) {
    this.closeStream();
    this.reader = this.file.stream().getReader();
    this.streamPos = 0;
    let skipped = 0;
    // fast-forward to the resume point by reading and discarding
    while (this.streamPos < fromOffset) {
      const { done, value } = await withTimeout(this.reader.read(), 45000, 'skipping to resume point');
      if (done) throw new Error(`file ended at ${this.streamPos} while seeking ${fromOffset}`);
      skipped += value.byteLength;
      if (this.streamPos + value.byteLength > fromOffset) {
        this.carry = value.subarray(fromOffset - this.streamPos);
        this.streamPos = fromOffset;
      } else {
        this.streamPos += value.byteLength;
      }
    }
    if (skipped) dlog(`stream reopened, skipped ${fmtBytes(skipped)} to ${fmtBytes(fromOffset)}`);
  }

  async readChunk(want) {
    const parts = [];
    let got = 0;
    if (this.carry) {
      const take = this.carry.subarray(0, Math.min(want, this.carry.byteLength));
      parts.push(take);
      got += take.byteLength;
      this.carry = take.byteLength < this.carry.byteLength ? this.carry.subarray(take.byteLength) : null;
    }
    while (got < want) {
      const { done, value } = await withTimeout(this.reader.read(), 45000, `reading at ${fmtBytes(this.streamPos + got)}`);
      if (done) break;
      if (got + value.byteLength > want) {
        parts.push(value.subarray(0, want - got));
        this.carry = value.subarray(want - got);
        got = want;
      } else {
        parts.push(value);
        got += value.byteLength;
      }
    }
    const out = new Uint8Array(got);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.byteLength; }
    this.streamPos += got;
    return out;
  }

  render() {
    const li = document.createElement('li');
    li.className = 'tx ' + this.status;
    li.innerHTML = `
      <div class="ring">
        <svg viewBox="0 0 44 44">
          <circle class="track" cx="22" cy="22" r="19"></circle>
          <circle class="fill" cx="22" cy="22" r="19" stroke-dasharray="119.38" stroke-dashoffset="119.38"></circle>
        </svg>
        <div class="pct">0%</div>
      </div>
      <div class="tx-body">
        <div class="tx-name"></div>
        <div class="tx-meta"></div>
        <div class="tx-bar"><i></i></div>
      </div>
      <div class="tx-controls">
        <button class="btn ghost icon" data-act="toggle">Pause</button>
        <button class="btn ghost icon danger" data-act="cancel">Cancel</button>
      </div>`;
    li.querySelector('.tx-name').textContent = this.name;
    li.querySelector('[data-act="toggle"]').addEventListener('click', () => this.toggle());
    li.querySelector('[data-act="cancel"]').addEventListener('click', () => this.cancel());
    this.el = li;
    this.paint();
  }

  paint() {
    const el = this.el;
    if (!el) return;
    el.className = 'tx ' + this.status;

    const pct = this.pct;
    const circ = 2 * Math.PI * 19;
    el.querySelector('.fill').setAttribute('stroke-dashoffset', String(circ * (1 - pct / 100)));
    el.querySelector('.pct').textContent = Math.floor(pct) + '%';
    el.querySelector('.tx-bar i').style.width = pct + '%';

    el.classList.toggle('stalled', this.stalled && this.status === 'uploading');

    const meta = el.querySelector('.tx-meta');
    const left = this.size - this.sent;
    if (this.status === 'uploading' && this.stalled === 'awaiting') {
      meta.innerHTML = `<span class="k">sent</span> ${fmtBytes(this.sent)} <span class="k">— waiting for the server to confirm</span>` +
        (this.attempt ? ` <span class="k">·</span> attempt ${this.attempt}/${MAX_RETRIES}` : '');
    } else if (this.status === 'uploading' && this.stalled) {
      meta.innerHTML = `<span class="k">connection went quiet at</span> ${fmtBytes(this.sent)}` +
        ` <span class="k">·</span> retrying shortly` +
        (this.attempt ? ` <span class="k">·</span> attempt ${this.attempt}/${MAX_RETRIES}` : '');
    } else if (this.status === 'uploading') {
      meta.innerHTML = `${fmtBytes(this.sent)} <span class="k">of</span> ${fmtBytes(this.size)}` +
        ` <span class="k">·</span> ${fmtRate(this.rate)}` +
        ` <span class="k">·</span> ${fmtEta(this.rate > 0 ? left / this.rate : Infinity)} left` +
        ` <span class="k">·</span> ${fmtBytes(this.chunk)} chunks` +
        (this.attempt ? ` <span class="k">·</span> retry ${this.attempt}` : '');
    } else if (this.status === 'done') {
      const secs = (Date.now() - this.startedAt) / 1000;
      meta.innerHTML = `<span class="k">done</span> ${fmtBytes(this.size)} <span class="k">in</span> ${fmtEta(secs)}` +
        ` <span class="k">·</span> avg ${fmtRate(this.size / Math.max(secs, 0.001))}`;
    } else if (this.status === 'error') {
      meta.innerHTML = `<span class="k">failed</span> — ${esc(this.error)}`;
    } else if (this.status === 'paused') {
      meta.innerHTML = `<span class="k">paused at</span> ${fmtBytes(this.sent)} <span class="k">of</span> ${fmtBytes(this.size)}`;
    } else if (this.status === 'cancelled') {
      meta.innerHTML = `<span class="k">cancelled</span>`;
    } else {
      meta.innerHTML = `<span class="k">queued</span> · ${fmtBytes(this.size)}`;
    }

    const toggle = el.querySelector('[data-act="toggle"]');
    const cancel = el.querySelector('[data-act="cancel"]');
    const finished = this.status === 'done' || this.status === 'cancelled' || this.status === 'error';
    toggle.textContent = this.status === 'paused' ? 'Resume' : 'Pause';
    toggle.hidden = finished;
    cancel.textContent = finished ? 'Dismiss' : 'Cancel';
    cancel.classList.toggle('danger', !finished);
  }

  toggle() {
    if (this.status === 'uploading') {
      this.status = 'paused';
      if (this.xhr) { this.xhr.abort(); this.xhr = null; }
      this.closeStream();
      this.paint();
      pump();
    } else if (this.status === 'paused' || this.status === 'error') {
      this.status = 'queued';
      this.error = '';
      this.paint();
      pump();
    }
  }

  cancel() {
    const finished = this.status === 'done' || this.status === 'cancelled' || this.status === 'error';
    if (!finished) {
      this.status = 'cancelled';
      if (this.xhr) { this.xhr.abort(); this.xhr = null; }
      this.closeStream();
      unpersist(this.id);
      fetch('/api/upload/' + this.id, { method: 'DELETE' }).catch(() => {});
      this.paint();
      pump();
    }
    this.dismiss();
  }

  dismiss() {
    const el = this.el;
    if (!el) return;
    el.classList.add('leaving');
    setTimeout(() => {
      el.remove();
      state.queue = state.queue.filter((t) => t !== this);
      updateQueueChrome();
    }, 340);
  }

  // Adapt chunk size toward TARGET_CHUNK_SECONDS of wire time, clamped.
  adaptChunk(bytes, seconds) {
    if (seconds <= 0.01) return;
    const observed = bytes / seconds;
    const want = observed * TARGET_CHUNK_SECONDS;
    // move a third of the way there so a single blip does not whipsaw the size
    const next = this.chunk + (want - this.chunk) / 3;
    this.chunk = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK_EFF, Math.round(next / MIN_CHUNK) * MIN_CHUNK)) || MIN_CHUNK;
  }

  putChunk(offset, payload) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.xhr = xhr;
      xhr.open('PUT', '/api/upload/' + this.id + '?offset=' + offset, true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.timeout = HARD_TIMEOUT_MS;

      const base = offset;
      const sentAt = performance.now();
      let lastLoaded = 0, lastT = performance.now();
      let lastMove = performance.now();
      let handedOffAt = 0;     // when the whole body reached the OS
      let abandoned = false;   // aborted by the watchdog, not by the user
      let settled = false;     // promise resolved/rejected — ignore stragglers
      let probing = false;

      // Sending: bytes should keep moving. Awaiting: silence is expected —
      // but not much of it. The phone logs proved the server can answer a
      // chunk in ~100ms and the 200 still never reaches the XHR (the reply
      // dies somewhere on the path, e.g. inside a VPN tunnel). So instead of
      // trusting this socket, ask the server on a FRESH connection whether
      // the chunk landed; if it did, drop the zombie XHR and move on.
      const watchdog = setInterval(() => {
        if (this.status !== 'uploading' || settled) return;
        const awaiting = handedOffAt > 0;
        const quiet = performance.now() - (awaiting ? handedOffAt : lastMove);
        if (awaiting && quiet >= PROBE_AFTER_MS && !probing) {
          probing = true;
          fetch('/api/upload/' + this.id + '/status', { cache: 'no-store' })
            .then((r) => r.json())
            .then((st2) => {
              if (settled || typeof st2.received !== 'number') return;
              if (st2.received >= base + payload.byteLength) {
                dlog(`reply lost but chunk landed (server @${fmtBytes(st2.received)}) — moving on`);
                settled = true;
                done();
                try { xhr.abort(); } catch (_) {}
                resolve(st2.received);
              }
            })
            .catch(() => {})
            .finally(() => { probing = false; });
        }
        const [warnAt, abortAt] = awaiting
          ? [RESPONSE_WARN_MS, RESPONSE_GRACE_MS]
          : [STALL_WARN_MS, STALL_ABORT_MS];
        if (quiet >= abortAt) {
          abandoned = true;
          this.abortedWhileAwaiting = awaiting;
          xhr.abort();                       // -> onabort -> retryable rejection
        } else if (quiet >= warnAt && this.stalled !== (awaiting ? 'awaiting' : 'sending')) {
          this.stalled = awaiting ? 'awaiting' : 'sending';
          this.paint();
        }
      }, 1000);

      const done = () => {
        settled = true;
        clearInterval(watchdog);
        this.xhr = null;
        this.stalled = false;
      };

      xhr.upload.onprogress = (e) => {
        if (this.status !== 'uploading') return;
        this.sent = base + e.loaded;
        const now = performance.now();
        if (e.loaded > lastLoaded) {
          lastMove = now;
          if (this.stalled) { this.stalled = false; this.paint(); }
        }
        const dt = (now - lastT) / 1000;
        if (dt > 0.25) {
          const inst = (e.loaded - lastLoaded) / dt;
          this.rate = this.rate ? this.rate * 0.72 + inst * 0.28 : inst;
          lastLoaded = e.loaded; lastT = now;
        }
        this.paint();
        updateQueueChrome();
      };
      // Body fully handed to the OS — from here the reply is what we wait on.
      xhr.upload.onload = () => { handedOffAt = performance.now(); };
      xhr.onload = () => {
        done();
        if (xhr.status >= 200 && xhr.status < 300) {
          let body = {};
          try { body = JSON.parse(xhr.responseText); } catch (_) {}
          resolve(typeof body.received === 'number' ? body.received : base + payload.byteLength);
        } else {
          let msg = 'HTTP ' + xhr.status;
          try { const j = JSON.parse(xhr.responseText); if (j.error) msg = j.error; } catch (_) {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => {
        // Diagnostic: on the phone these failures never reach the server at
        // all — no PUT shows up in its log — so record what the XHR itself
        // saw. status 0 + readyState 1 means Safari refused to send it.
        dlog(`xhr error @${fmtBytes(offset)} +${fmtBytes(payload.byteLength)}`
          + ` status=${xhr.status} rs=${xhr.readyState}`
          + ` sent=${Math.round(performance.now() - sentAt)}ms`
          + ` handedOff=${handedOffAt ? 'yes' : 'no'} unloading=${pageUnloading}`);
        done();
        reject(new Error('network error'));
      };
      xhr.ontimeout = () => { done(); reject(new Error('chunk timed out')); };
      xhr.onabort = () => {
        done();
        // A watchdog abort must retry; a user pause must not.
        if (abandoned) {
          const awaiting = this.abortedWhileAwaiting;
          reject(Object.assign(
            new Error(awaiting ? 'server did not reply in time' : 'stalled — no data was moving'),
            { sendWasFine: awaiting },
          ));
        } else {
          reject(Object.assign(new Error('aborted'), { aborted: true }));
        }
      };
      dlog(`send chunk @${fmtBytes(offset)} +${fmtBytes(payload.byteLength)}`);
      xhr.send(payload);
    });
  }

  async run() {
    // One loop per transfer, ever. Revival paths (visibility, online, the 30s
    // sweep) can all call pump() while an earlier run() is still awaiting a
    // slow read or retry backoff — a second loop on the same transfer means
    // two XHRs racing on one upload id.
    if (this.running) { dlog(`run() re-entry blocked for ${this.name}`); return; }
    this.running = true;
    try {
      return await this.runInner();
    } finally {
      this.running = false;
    }
  }

  async runInner() {
    this.status = 'uploading';
    this.startedAt = this.startedAt || Date.now();
    this.paint();

    const init = await api('/api/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: this.id, name: this.name, size: this.size, type: this.type }),
    });
    this.sent = init.received || 0;
    // server may cap per-PUT size; never send a chunk it would reject
    const cap = Math.min(MAX_CHUNK_EFF, init.maxChunk || MAX_CHUNK_EFF);
    if (init.chunkSize) this.chunk = Math.max(MIN_CHUNK, Math.min(cap, init.chunkSize));
    else this.chunk = Math.min(this.chunk, cap);
    if (this.sent > 0) toast(`Resuming ${this.name} at ${fmtBytes(this.sent)}`);
    this.paint();

    let retries = 0;
    while (this.sent < this.size) {
      if (this.status !== 'uploading') return; // paused / cancelled
      const end = Math.min(this.sent + this.chunk, this.size);

      // Acquire the chunk's bytes BEFORE handing them to XHR, via a single
      // sequential pass over file.stream(). Reading lazily inside xhr.send
      // hangs on iOS (headers go out, the body never follows), and repeated
      // random-access slice() reads hang from the second one onward on
      // Photos-picked files. One forward-only stream avoids both.
      let payload = null;
      for (let readTry = 1; readTry <= 3 && payload === null; readTry++) {
        const r0 = performance.now();
        try {
          if (this.file.stream) {
            if (!this.reader || this.streamPos !== this.sent) await this.openStream(this.sent);
            payload = await this.readChunk(end - this.sent);
            if (payload.byteLength === 0) throw new Error(`file ended early at ${fmtBytes(this.sent)}`);
          } else {
            payload = new Uint8Array(await withTimeout(
              this.file.slice(this.sent, end).arrayBuffer(),
              45000, `reading ${fmtBytes(end - this.sent)} from the file`,
            ));
          }
          dlog(`read ${fmtBytes(payload.byteLength)} @${fmtBytes(this.sent)} in ${Math.round(performance.now() - r0)}ms`);
        } catch (e) {
          dlog(`read failed (try ${readTry}/3): ${e.name || ''} ${e.message}`);
          this.closeStream();          // a fresh stream() is the only reliable retry
          if (readTry === 3) {
            // The backing file is unreadable for good. Re-picking the same
            // file resumes from this exact offset — ids are content-keyed.
            this.status = 'error';
            this.fatal = true; // re-picking is the only cure; do not auto-revive
            unpersist(this.id); // the stored File is unreadable; a fresh pick replaces it
            this.error = `cannot read the file from the photo library — tap the dropzone and pick the same file again to resume from ${fmtBytes(this.sent)}`;
            this.paint();
            toast(this.error, true);
            return;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (this.status !== 'uploading') return;
      }

      const t0 = performance.now();
      try {
        const received = await this.putChunk(this.sent, payload);
        const secs = (performance.now() - t0) / 1000;
        this.adaptChunk(payload.byteLength, secs);
        this.sent = received;
        retries = 0;
        this.attempt = 0;
        this.paint();
        updateQueueChrome();
      } catch (err) {
        if (err && err.aborted) return;
        dlog(`chunk @${fmtBytes(this.sent)} failed: ${err.message}`);
        if (++retries > MAX_RETRIES) throw err;
        this.attempt = retries;
        const backoff = Math.min(15000, 500 * 2 ** (retries - 1));
        toast(`${this.name}: ${err.message} — retry ${retries}/${MAX_RETRIES}`, true);
        await new Promise((r) => setTimeout(r, backoff));
        // re-sync with the server so a half-written chunk cannot desync the
        // offset — and so a chunk it did commit is not re-sent
        try {
          const st = await api('/api/upload/' + this.id + '/status');
          this.sent = st.received || 0;
        } catch (_) { /* keep local offset and let the server reject a bad one */ }
        // Only shrink when the *sending* struggled. A slow reply is not a
        // bandwidth problem, and halving on it spirals down to MIN_CHUNK.
        if (!err.sendWasFine) this.chunk = Math.max(MIN_CHUNK, Math.round(this.chunk / 2));
        this.paint();
      }
    }

    this.closeStream();
    const res = await api('/api/upload/' + this.id + '/complete', { method: 'POST' });
    this.status = 'done';
    unpersist(this.id);
    this.paint();
    if (res && res.item) addItem(res.item);
    toast(`${this.name} uploaded`);
  }
}

/* ── queue pump (one file on the wire at a time) ─────── */

async function pump() {
  updateQueueChrome();
  if (state.active) return;
  const next = state.queue.find((t) => t.status === 'queued');
  if (!next) { els.statNet.textContent = 'idle'; keepAwake(false); return; }
  state.active = next;
  keepAwake(true);
  dlog(`start ${next.name} (${fmtBytes(next.size)}, ${next.type || 'no type'})`);
  try {
    await next.run();
  } catch (err) {
    if (next.status !== 'cancelled') {
      next.status = 'error';
      next.error = err.message || String(err);
      next.paint();
      toast(`${next.name} failed: ${next.error}`, true);
    }
  } finally {
    state.active = null;
    updateQueueChrome();
    pump();
  }
}

/* ── revival: nothing stays dead while the page is open ──
 *
 * This is what made a stalled iPhone upload need a manual page refresh. iOS
 * freezes all JS the moment Safari is backgrounded (or the screen locks) and
 * kills the socket under the in-flight chunk. On return the watchdog aborts
 * immediately — correctly — but each abort spends one of MAX_RETRIES, and the
 * budget only resets after a chunk *succeeds*. A few background/foreground
 * cycles burn all 8, run() throws, pump() parks the transfer in 'error' and
 * moves on. Reloading the tab was the only way back, because boot() rebuilds
 * the queue from IndexedDB and asks the server for the offset.
 *
 * So: treat any sign of life as a reason to try again. A revived transfer
 * re-enters run(), which re-inits against the server and picks up at the byte
 * offset the .part file already holds — the same thing the reload was doing,
 * minus the reload.
 */
function reviveStalled(why) {
  const dead = state.queue.filter((t) => t.status === 'error' && !t.fatal);
  for (const t of dead) {
    t.status = 'queued';
    t.error = '';
    t.attempt = 0;
    t.closeStream();  // the old reader points into a file handle iOS may have moved
    t.paint();
  }
  if (dead.length) {
    dlog(`revived ${dead.length} stalled transfer(s) — ${why}`);
    toast(`업로드 자동 재개: ${dead.length}개 (${why})`);
  }
  if (dead.length || state.queue.some((t) => t.status === 'queued')) pump();
}

window.addEventListener('online', () => reviveStalled('network is back'));
// Events get dropped when iOS suspends the tab, so also sweep on a slow timer.
setInterval(() => {
  if (document.visibilityState === 'visible') reviveStalled('periodic retry');
}, 30000);

/* ── one uploader across tabs ────────────────────────────
 * The queue lives in shared IndexedDB, so if two page instances boot (a new
 * tab plus a bfcache zombie, or just two tabs), both auto-restore the same
 * file and fight over the upload id. A heartbeat in localStorage marks "a
 * tab is actively uploading"; other tabs hold their auto-restore until the
 * beat goes stale (~7s), which also covers the beating tab dying.
 */
const TAB_ID = Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
const BEAT_KEY = 'uploaderBeat';
const BEAT_STALE_MS = 7000;

setInterval(() => {
  if (!state.active) return;
  try { localStorage.setItem(BEAT_KEY, JSON.stringify({ t: Date.now(), tab: TAB_ID })); } catch (_) {}
}, 2000);

function otherTabUploading() {
  try {
    const beat = JSON.parse(localStorage.getItem(BEAT_KEY) || 'null');
    return !!beat && beat.tab !== TAB_ID && Date.now() - beat.t < BEAT_STALE_MS;
  } catch (_) { return false; }
}

function updateQueueChrome() {
  els.queue.hidden = state.queue.length === 0;
  const pending = state.queue.filter((t) => t.status === 'queued' || t.status === 'uploading' || t.status === 'paused');
  const total = pending.reduce((a, t) => a + t.size, 0);
  const sent = pending.reduce((a, t) => a + t.sent, 0);
  els.queueSummary.textContent = pending.length
    ? `${pending.length} pending · ${fmtBytes(sent)} / ${fmtBytes(total)}`
    : 'all transfers finished';
  els.statNet.textContent = state.active && state.active.status === 'uploading'
    ? fmtRate(state.active.rate)
    : 'idle';
}

/* ── gallery ─────────────────────────────────────────── */

function addItem(item) {
  if (state.items.some((i) => i.id === item.id)) return;
  state.items.unshift(item);
  renderGrid(item.id);
  updateStats();
}

function updateStats() {
  els.statCount.textContent = state.items.length + (state.items.length === 1 ? ' item' : ' items');
  els.statSize.textContent = fmtBytes(state.items.reduce((a, i) => a + (i.size || 0), 0));
}

function visibleItems() {
  return state.filter === 'all' ? state.items : state.items.filter((i) => i.kind === state.filter);
}

function renderGrid(freshId) {
  const items = visibleItems();
  els.grid.innerHTML = '';
  els.empty.hidden = items.length > 0;

  items.forEach((item, idx) => {
    const card = document.createElement('article');
    card.className = 'card' + (item.id === freshId ? ' fresh' : '');
    card.style.setProperty('--d', Math.min(idx, 18) * 32 + 'ms');
    card.tabIndex = 0;

    const skel = document.createElement('div');
    skel.className = 'skeleton';
    card.appendChild(skel);

    const kind = document.createElement('span');
    kind.className = 'kind ' + item.kind;
    kind.textContent = item.kind === 'video' ? '▶ video' : 'photo';
    card.appendChild(kind);

    let media;
    if (item.kind === 'video') {
      media = document.createElement('video');
      media.src = '/media/' + item.id + '#t=0.1';
      media.muted = true;
      media.playsInline = true;
      media.preload = 'metadata';
      media.addEventListener('loadeddata', () => { media.classList.add('loaded'); skel.remove(); });
      media.addEventListener('error', () => { skel.remove(); });
    } else {
      media = document.createElement('img');
      media.src = '/media/' + item.id;
      media.alt = item.name;
      media.loading = 'lazy';
      media.decoding = 'async';
      media.addEventListener('load', () => { media.classList.add('loaded'); skel.remove(); });
      media.addEventListener('error', () => { skel.remove(); });
    }
    card.appendChild(media);

    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div style="min-width:0"><div class="fname"></div><div class="fsize"></div></div>
                    <button class="del" title="Delete">&times;</button>`;
    ov.querySelector('.fname').textContent = item.name;
    ov.querySelector('.fsize').textContent = fmtBytes(item.size);
    ov.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); removeItem(item, card); });
    card.appendChild(ov);

    card.addEventListener('click', () => openLightbox(idx));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') openLightbox(idx); });
    els.grid.appendChild(card);
  });
}

async function removeItem(item, card) {
  if (!confirm('Delete "' + item.name + '"?')) return;
  card.classList.add('removing');
  try {
    await api('/api/media/' + item.id, { method: 'DELETE' });
    state.items = state.items.filter((i) => i.id !== item.id);
    setTimeout(() => { renderGrid(); updateStats(); }, 300);
    toast('Deleted');
  } catch (err) {
    card.classList.remove('removing');
    toast('Delete failed: ' + err.message, true);
  }
}

/* ── lightbox ────────────────────────────────────────── */

function openLightbox(idx) {
  const items = visibleItems();
  if (!items.length) return;
  state.lbIndex = (idx + items.length) % items.length;
  const item = items[state.lbIndex];

  els.lbStage.innerHTML = '';
  if (item.kind === 'video') {
    const v = document.createElement('video');
    v.src = '/media/' + item.id;
    v.controls = true;
    v.autoplay = true;
    v.playsInline = true;
    els.lbStage.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.src = '/media/' + item.id;
    img.alt = item.name;
    els.lbStage.appendChild(img);
  }
  els.lbCaption.textContent = `${item.name} · ${fmtBytes(item.size)} · ${item.type || item.kind}`;
  els.lightbox.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  els.lightbox.hidden = true;
  els.lbStage.innerHTML = '';
  document.body.style.overflow = '';
  state.lbIndex = -1;
}

/* ── input wiring ────────────────────────────────────── */

async function enqueue(fileList, opts) {
  const restored = !!(opts && opts.restored);
  // On restore we replay the id we stored, rather than recomputing it: iOS may
  // have purged the temp file the File points at, and a failed probe would
  // otherwise fall back to a different key and lose the partial.
  const knownIds = (opts && opts.ids) || null;
  const files = Array.from(fileList || []);
  let added = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.size > MAX_BYTES) { toast(`${f.name} is ${fmtBytes(f.size)} — over the ${fmtBytes(MAX_BYTES)} limit`, true); continue; }
    if (f.size === 0) { toast(`${f.name} is empty`, true); continue; }
    const id = (knownIds && knownIds[i]) || await keyFor(f);
    const dup = state.queue.find((q) => q.id === id && !['done', 'cancelled'].includes(q.status));
    if (dup) {
      // picking the same file again replaces a dead/stuck row with a fresh one
      if (dup.status === 'error' || dup.status === 'paused') dup.dismiss();
      else continue;
    }
    const t = new Transfer(f, id);
    state.queue.push(t);
    els.queueList.appendChild(t.el);
    if (!restored) {
      store.put({ id: t.id, file: f, addedAt: Date.now() })
        .then(() => dlog(`queue persisted: ${f.name}`))
        .catch((e) => dlog('queue persist failed: ' + e.message));
    }
    added++;
  }
  if (added) { els.queue.hidden = false; keepAwake(true); pump(); }
}

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener('change', (e) => {
  enqueue(e.target.files).catch((err) => toast('Could not queue: ' + err.message, true));
  e.target.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) els.dragVeil.classList.add('show'); });
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; els.dragVeil.classList.remove('show'); } });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dragVeil.classList.remove('show');
  els.dropzone.classList.remove('is-over');
  if (e.dataTransfer && e.dataTransfer.files.length) {
    enqueue(e.dataTransfer.files).catch((err) => toast('Could not queue: ' + err.message, true));
  }
});
els.dropzone.addEventListener('dragover', () => els.dropzone.classList.add('is-over'));
els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('is-over'));

els.clearDone.addEventListener('click', () => {
  state.queue.filter((t) => ['done', 'error', 'cancelled'].includes(t.status)).forEach((t) => t.dismiss());
});

document.querySelectorAll('.filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    state.filter = btn.dataset.filter;
    renderGrid();
  });
});

els.lbClose.addEventListener('click', closeLightbox);
els.lbPrev.addEventListener('click', () => openLightbox(state.lbIndex - 1));
els.lbNext.addEventListener('click', () => openLightbox(state.lbIndex + 1));
els.lightbox.addEventListener('click', (e) => { if (e.target === els.lightbox) closeLightbox(); });
document.addEventListener('keydown', (e) => {
  if (els.lightbox.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') openLightbox(state.lbIndex - 1);
  if (e.key === 'ArrowRight') openLightbox(state.lbIndex + 1);
});

// swipe between items on touch devices
(function swipe() {
  let x0 = null, y0 = null;
  els.lightbox.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  els.lightbox.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) openLightbox(state.lbIndex + (dx < 0 ? 1 : -1));
    x0 = y0 = null;
  }, { passive: true });
})();

window.addEventListener('beforeunload', (e) => {
  if (state.queue.some((t) => t.status === 'uploading')) { e.preventDefault(); e.returnValue = ''; }
});

/* ── boot ────────────────────────────────────────────── */

(async function boot() {
  mountDebugPanel();
  replayPrevLog();
  try {
    const h = await api('/api/health');
    els.backendName.textContent = `${h.backend} · :${h.port}`;
    els.backendBadge.classList.add('online');
    document.title = `Aperture — ${h.backend}`;
  } catch (_) {
    els.backendName.textContent = 'backend unreachable';
    els.backendBadge.classList.add('offline');
  }
  try {
    const data = await api('/api/media');
    state.items = data.items || [];
    renderGrid();
    updateStats();
  } catch (err) {
    toast('Could not load library: ' + err.message, true);
  }
  // resurrect uploads a previous incarnation of this page did not finish —
  // on iOS the tab is routinely reloaded out from under an active transfer.
  // If another live tab is already uploading (heartbeat fresh), wait for its
  // beat to go stale rather than starting a second uploader on the same id.
  async function restoreQueue() {
    if (otherTabUploading()) {
      dlog('another tab is uploading — holding auto-restore');
      toast('다른 탭이 업로드 중 — 잠시 후 자동으로 이어갑니다');
      setTimeout(restoreQueue, 3000);
      return;
    }
    try {
      const pending = (await store.all()).filter((r) => r && r.file && r.file.size > 0);
      const fresh = pending.filter((r) => !state.queue.some((t) => t.id === r.id));
      if (fresh.length) {
        dlog(`restoring ${fresh.length} interrupted upload(s)`);
        toast(`이어서 업로드: ${fresh.length}개 자동 재개`);
        await enqueue(fresh.map((r) => r.file), { restored: true, ids: fresh.map((r) => r.id) });
      }
    } catch (e) {
      dlog('queue restore failed: ' + e.message);
    }
    updateQueueChrome();
  }
  await restoreQueue();

  // ?debug=1&selftest=44 → upload a synthetic 44 MB file through the real
  // pipeline. Exists so an iOS Simulator (or any browser) can exercise the
  // full XHR upload path without touching the file picker. Gated behind
  // DEBUG: it allocates the file in memory, so it is not something a stray
  // link should be able to trigger.
  const selftestMB = DEBUG ? Number(new URLSearchParams(location.search).get('selftest') || 0) : 0;
  if (selftestMB > 0 && !state.queue.length) {
    const mb = Math.min(selftestMB, 500);
    dlog(`selftest: building a ${mb} MB synthetic file`);
    const parts = [];
    let seed = 0x2545f491;
    for (let i = 0; i < mb; i++) {
      const block = new Uint8Array(1024 * 1024);
      for (let j = 0; j < block.length; j += 4) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        block[j] = seed & 0xff; block[j + 1] = (seed >> 8) & 0xff;
        block[j + 2] = (seed >> 16) & 0xff; block[j + 3] = (seed >> 24) & 0xff;
      }
      parts.push(block);
    }
    const f = new File(parts, `selftest-${mb}mb.bin`, { type: 'video/mp4' });
    dlog('selftest: enqueueing');
    enqueue([f]).catch((e) => dlog('selftest enqueue failed: ' + e.message));
  }
})();
