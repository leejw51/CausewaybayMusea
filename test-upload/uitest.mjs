/**
 * Browser test for the Aperture gallery UI (Playwright, headless Chromium).
 *
 *   node uitest.mjs 8701          one backend
 *   node uitest.mjs all           8701 + 8702 + 8703
 *   HEADED=1 node uitest.mjs 8701 watch it happen
 *
 * `smoketest.py` proves the HTTP protocol. This proves the parts only a real
 * browser can: that progress actually ticks, that a paused transfer stops,
 * that losing the network mid-upload resumes from the server's offset instead
 * of restarting, and that a video streams by byte range rather than being
 * downloaded whole.
 *
 * Requires `npm install` in this folder and ./fixtures (run ./fixtures.sh).
 */

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const PHOTO = path.join(FIX, 'photo.jpg');
const TALL = path.join(FIX, 'photo-tall.jpg');
const CLIP = path.join(FIX, 'clip.mp4');
const MEDIUM = path.join(FIX, 'medium.mp4');

const UP_BPS = (40 * 1024 * 1024) / 8; // ~40 Mbps, a phone on Wi-Fi over Tailscale
// Slower rate for the pause/stall/outage sequence, so the file cannot finish
// uploading in the gaps between the three interruptions we stage.
const SLOW_BPS = (12 * 1024 * 1024) / 8;
const DOWN_BPS = (80 * 1024 * 1024) / 8;

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', n: '\x1b[0m' }
  : { g: '', r: '', d: '', b: '', n: '' };

let passed = 0;
let failed = 0;

function ok(msg) { passed++; console.log(`${C.g}✓${C.n} ${msg}`); }
function bad(msg) { failed++; console.log(`${C.r}✗${C.n} ${msg}`); }
function note(msg) { console.log(`${C.d}·${C.n} ${msg}`); }
function check(cond, good, wrong) { cond ? ok(good) : bad(wrong); return cond; }

async function throttle(cdp, { offline = false, up = UP_BPS } = {}) {
  await cdp.send('Network.emulateNetworkConditions', {
    offline,
    latency: offline ? 0 : 60,
    downloadThroughput: offline ? 0 : DOWN_BPS,
    uploadThroughput: offline ? 0 : up,
  });
}

async function unthrottle(cdp) {
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
}

const txt = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
const LIVE = '.tx:last-child';
const pct = (page) => page.evaluate((s) => parseInt(document.querySelector(s + ' .pct')?.textContent ?? '-1', 10), LIVE);

async function wipe(page) {
  await page.evaluate(async () => {
    const l = await (await fetch('/api/media')).json();
    for (const i of l.items) await fetch('/api/media/' + i.id, { method: 'DELETE' });
  });
}

async function runFor(port, browser) {
  const base = `http://127.0.0.1:${port}`;
  console.log(`\n${C.b}━━ uitest ${base}${C.n}\n`);

  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // 404s (we delete media out from under an open tab) and the disconnect we
  // trigger ourselves in step 9 are expected; anything else is a real bug.
  const EXPECTED = /404|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION_REFUSED|Failed to fetch|timed out/;
  page.on('console', (m) => { if (m.type() === 'error' && !EXPECTED.test(m.text())) errors.push(m.text()); });

  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');

  try {
    // ── 1. page loads and identifies its backend ──────────────────
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('backendBadge').classList.contains('online'), null, { timeout: 15000 });
    const badge = await txt(page, '#backendName');
    check(badge.includes(String(port)), `page loads, badge reads "${badge}"`, `badge says "${badge}"`);
    await wipe(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // the invisible lightbox must not eat clicks (it did once)
    const dzClickable = await page.evaluate(() => {
      const r = document.getElementById('dropzone').getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return document.getElementById('dropzone').contains(el);
    });
    check(dzClickable, 'the dropzone is the topmost element at its centre', 'something invisible is covering the dropzone');

    // ── 2. upload a photo and a video ─────────────────────────────
    await page.locator('#fileInput').setInputFiles([PHOTO, TALL, CLIP]);
    await page.waitForFunction(() => {
      const t = [...document.querySelectorAll('.tx')];
      return t.length === 3 && t.every((e) => e.className.includes('done'));
    }, null, { timeout: 120000 });
    const cards = await page.locator('.grid .card').count();
    check(cards === 3, `3 files uploaded and 3 cards rendered`, `expected 3 cards, found ${cards}`);
    check((await txt(page, '#statCount')) === '3 items', 'header item count updated', `header says ${await txt(page, '#statCount')}`);

    // ── 3. images and video thumbnails actually decode ────────────
    const decoded = await page.evaluate(async () => {
      const imgs = [...document.querySelectorAll('.grid img')];
      await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => i.addEventListener('load', r, { once: true })))));
      const v = document.querySelector('.grid video');
      if (v && v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
      return {
        imgs: imgs.map((i) => i.naturalWidth),
        videoW: v?.videoWidth ?? 0,
        videoDur: v?.duration ?? 0,
      };
    });
    check(decoded.imgs.length === 2 && decoded.imgs.every((w) => w > 0),
      `both photos decoded (${decoded.imgs.join(', ')} px wide)`, `photos failed to decode: ${JSON.stringify(decoded.imgs)}`);
    check(decoded.videoW > 0 && decoded.videoDur > 0,
      `video thumbnail decoded (${decoded.videoW}px, ${decoded.videoDur.toFixed(1)}s)`, 'video thumbnail did not decode');

    // ── 4. lightbox: video plays and seeks over byte ranges ───────
    const ranged = [];
    page.on('response', (r) => { if (r.status() === 206 && r.url().includes('/media/')) ranged.push(r.url()); });
    await page.locator('.grid .card').filter({ has: page.locator('video') }).first().click();
    await page.waitForSelector('#lbStage video', { timeout: 10000 });
    const seek = await page.evaluate(async () => {
      const v = document.querySelector('#lbStage video');
      if (v.readyState < 2) await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
      v.currentTime = Math.max(0, v.duration - 1.5);
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      return { t: v.currentTime, dur: v.duration, w: v.videoWidth };
    });
    check(seek.t > 0 && seek.w > 0, `lightbox video seeks to ${seek.t.toFixed(1)}s of ${seek.dur.toFixed(1)}s`, 'lightbox video would not seek');
    check(ranged.length > 0, `server answered ${ranged.length} range request(s) with 206`, 'no 206 responses — video is being downloaded whole');

    await page.keyboard.press('ArrowRight');
    const cap = await txt(page, '#lbCaption');
    check(!!cap && !cap.includes('clip.mp4'), `arrow key advances the lightbox (${cap})`, 'arrow key did not advance');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('lightbox').hasAttribute('hidden'), null, { timeout: 5000 });
    ok('Escape closes the lightbox');

    // ── 5. filters ────────────────────────────────────────────────
    await page.locator('.filter[data-filter="video"]').click();
    check((await page.locator('.grid .card').count()) === 1, 'Videos filter shows only the clip', 'video filter wrong');
    await page.locator('.filter[data-filter="image"]').click();
    check((await page.locator('.grid .card').count()) === 2, 'Photos filter shows only the two photos', 'photo filter wrong');
    await page.locator('.filter[data-filter="all"]').click();

    // ── 6. progress actually ticks (throttled) ────────────────────
    await throttle(cdp, { up: SLOW_BPS });
    await page.evaluate(() => {
      window.__steps = new Set();
      new MutationObserver(() => {
        const p = document.querySelector('.tx.uploading .pct')?.textContent;
        if (p) window.__steps.add(p);
      }).observe(document.getElementById('queueList'), { subtree: true, attributes: true, childList: true, characterData: true });
    });
    await page.locator('#fileInput').setInputFiles(MEDIUM);
    await page.waitForFunction((s) => (parseInt(document.querySelector(s + ' .pct')?.textContent ?? '0') >= 10), LIVE, { timeout: 120000 });

    // ── 7. pause really stops the wire ────────────────────────────
    await page.waitForFunction((s) => document.querySelector(s)?.className.includes('uploading'), LIVE, { timeout: 30000 });
    await page.locator(`${LIVE} [data-act="toggle"]`).click();
    await page.waitForFunction((s) => document.querySelector(s)?.className.includes('paused'), LIVE, { timeout: 15000 });
    const atPause = await pct(page);
    const btn = await txt(page, `${LIVE} [data-act="toggle"]`);
    check(btn === 'Resume', `paused at ${atPause}%, button flips to Resume`, `button says "${btn}"`);
    await page.waitForTimeout(3000);
    check((await pct(page)) === atPause, `still ${atPause}% after 3s — nothing on the wire`, `moved to ${await pct(page)}% while paused`);
    check((await txt(page, '#statNet')) === 'idle', 'header rate reads idle while paused', 'header still shows a transfer rate');

    // ── 8. resume continues from where it stopped ─────────────────
    await page.locator(`${LIVE} [data-act="toggle"]`).click();
    await page.waitForFunction(([s, p]) => (parseInt(document.querySelector(s + ' .pct')?.textContent ?? '0') > p), [LIVE, atPause], { timeout: 60000 });
    check((await pct(page)) > atPause, `resumed and passed ${atPause}%`, 'resume did not advance');

    // ── 8b. the link goes quiet without dropping ──────────────────
    // This is the Tailscale DERP-relay failure: the socket stays open, the
    // chunk body is already buffered, and the response simply never arrives.
    // Nothing errors, so only a stall watchdog can notice.
    note('wedging the link (response crawls, socket stays open) …');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 60, downloadThroughput: 20, uploadThroughput: SLOW_BPS,
    });
    const sawStall = await page
      .waitForFunction((s) => document.querySelector(s)?.className.includes('stalled'), LIVE, { timeout: 45000 })
      .then(() => true, () => false);
    check(sawStall, 'a wedged link is detected and flagged as stalled', 'a wedged link looks identical to a healthy one — it will appear frozen');
    if (sawStall) {
      const m = await txt(page, `${LIVE} .tx-meta`);
      // either phase is a valid diagnosis here: a wedged link can look like a
      // silent send or like a reply that never comes
      check(/quiet|retry|waiting for the server/i.test(m ?? ''),
        `the row explains itself — "${m}"`, `stalled row says "${m}"`);
    }
    await throttle(cdp, { up: SLOW_BPS });
    await page.waitForFunction((s) => !document.querySelector(s)?.className.includes('stalled'), LIVE, { timeout: 90000 });
    ok('recovered once the link came back');

    // ── 9. the network drops, then comes back ─────────────────────
    const finishedEarly = await page.evaluate((s) => document.querySelector(s)?.className.includes('done'), LIVE);
    if (finishedEarly) {
      bad('upload finished before the outage step could run — throttle is too fast to test recovery');
      throw new Error('outage step had nothing in flight');
    }
    note('cutting the network mid-upload …');
    const atDrop = await pct(page);
    await throttle(cdp, { offline: true });
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /retry \d\/\d/.test(t.textContent)), null, { timeout: 40000 });
    const toast = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).pop());
    check(/retry/.test(toast ?? ''), `offline: client backs off and retries — "${toast}"`, 'no retry feedback while offline');
    check((await pct(page)) >= atDrop, 'progress held rather than rewinding to zero', 'progress reset while offline');

    note('reconnecting …');
    await throttle(cdp, { up: SLOW_BPS });
    await page.waitForFunction((s) => document.querySelector(s)?.className.includes('done'), LIVE, { timeout: 240000 });
    ok('upload recovered after the outage and completed');

    const steps = await page.evaluate(() => window.__steps.size);
    check(steps >= 15, `progress ticked through ${steps} distinct percentages over the transfer, not 0 → 100`,
      `only ${steps} progress update(s) across the whole upload — the bar is jumping`);

    // ── 10. what landed on disk is the whole file ─────────────────
    const integrity = await page.evaluate(async () => {
      const l = await (await fetch('/api/media')).json();
      const it = l.items.find((i) => i.name === 'medium.mp4');
      if (!it) return { ok: false, why: 'not in the library' };
      const h = await fetch('/media/' + it.id, { method: 'HEAD' });
      const served = Number(h.headers.get('content-length'));
      const tail = await fetch('/media/' + it.id, { headers: { Range: `bytes=${it.size - 1024}-` } });
      return { ok: served === it.size && tail.status === 206, size: it.size, served, tailStatus: tail.status };
    });
    check(integrity.ok, `stored file is complete (${integrity.served} bytes) and range-readable`,
      `stored file is wrong: ${JSON.stringify(integrity)}`);

    await unthrottle(cdp);

    // ── 11. iPhone viewport ───────────────────────────────────────
    await page.setViewportSize({ width: 393, height: 852 });
    await page.waitForTimeout(300);
    const phone = await page.evaluate(() => ({
      cols: getComputedStyle(document.getElementById('grid')).gridTemplateColumns.split(' ').length,
      hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      dzTapTarget: document.getElementById('dropzone').getBoundingClientRect().height,
    }));
    check(phone.cols === 2, 'iPhone width lays the grid out two-up', `grid has ${phone.cols} columns at 393px`);
    check(!phone.hScroll, 'no horizontal scroll at iPhone width', 'the page scrolls sideways on a phone');
    check(phone.dzTapTarget > 120, `dropzone is a ${Math.round(phone.dzTapTarget)}px tap target`, 'dropzone is too small to tap');
    await page.setViewportSize({ width: 1200, height: 900 });

    // ── 12. delete ────────────────────────────────────────────────
    page.once('dialog', (d) => d.accept());
    const before = await page.locator('.grid .card').count();
    await page.locator('.grid .card').first().hover();
    await page.locator('.grid .card .del').first().click();
    await page.waitForFunction((b) => document.querySelectorAll('.grid .card').length === b - 1, before, { timeout: 15000 });
    ok(`delete removed a card (${before} → ${before - 1})`);

    // ── 13. nothing blew up in the console ────────────────────────
    check(errors.length === 0, 'no uncaught page errors', `page errors: ${errors.slice(0, 3).join(' | ')}`);

    await wipe(page);
  } catch (err) {
    bad(`aborted: ${err.message.split('\n')[0]}`);
  } finally {
    await ctx.close();
  }
}

async function main() {
  for (const f of [PHOTO, TALL, CLIP, MEDIUM]) {
    if (!existsSync(f)) {
      console.error(`${C.r}missing fixture ${f}${C.n}\nrun ./fixtures.sh first`);
      process.exit(2);
    }
  }

  const arg = process.argv[2] ?? '8701';
  const ports = arg === 'all' ? [8701, 8702, 8703] : [Number(arg)];

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  try {
    for (const p of ports) await runFor(p, browser);
  } finally {
    await browser.close();
  }

  console.log();
  if (failed) {
    console.log(`${C.r}${C.b}${failed} check(s) failed${C.n} (${passed} passed)\n`);
    process.exit(1);
  }
  console.log(`${C.g}${C.b}all ${passed} browser checks passed${C.n}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
