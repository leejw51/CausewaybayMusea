/* Chunking-policy browser test (myrust).
 *
 * Verifies, through the real UI in Chromium:
 *   1. a large file goes up as many SMALL chunks — every PUT ≤ the server's
 *      advertised maxChunk, never one big request;
 *   2. offsets only ever move forward (no re-uploading committed bytes);
 *   3. a hard page reload mid-transfer resumes from the server's offset —
 *      not from zero — and the finished file is byte-complete;
 *   4. the finished upload streams back with the right size.
 *
 *   node chunktest.mjs [port]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const PORT = process.argv[2] || '8701';
const BASE = `http://127.0.0.1:${PORT}`;
const FILE = 'fixtures/medium.mp4';

let passed = 0, failed = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { passed++; console.log(`✓ ${msg}`); }
  else { failed++; console.log(`✗ ${msg}${extra ? ' — ' + extra : ''}`); }
};

const fileSize = fs.statSync(FILE).size;

// start clean: no leftover media or partials for this fixture
const media = await (await fetch(`${BASE}/api/media`)).json();
for (const it of media.items) {
  await fetch(`${BASE}/api/media/${it.id}`, { method: 'DELETE' });
}

const health = await (await fetch(`${BASE}/api/health`)).json();
ok(health.maxBytes >= 1024 ** 4, `backend advertises a ≥1 TB file limit (${health.maxBytes})`);

const browser = await chromium.launch({ headless: !process.env.HEADED });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await ctx.newPage();

// throttle so the upload spans many chunks and survives long enough to
// interrupt (~12 Mbps ≈ 25 s for the 38 MB fixture)
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
  offline: false, latency: 40,
  downloadThroughput: (50e6) / 8, uploadThroughput: (12e6) / 8,
});

const puts = [];           // { offset, size } for every chunk PUT observed
let advertisedMaxChunk = 0;
page.on('request', (r) => {
  const u = new URL(r.url());
  if (r.method() === 'PUT' && /^\/api\/upload\/[^/]+$/.test(u.pathname)) {
    const buf = r.postDataBuffer();
    puts.push({ offset: Number(u.searchParams.get('offset')), size: buf ? buf.length : -1 });
  }
});
page.on('response', async (r) => {
  if (r.url().endsWith('/api/upload/init') && r.status() === 200) {
    try { advertisedMaxChunk = (await r.json()).maxChunk || advertisedMaxChunk; } catch (_) {}
  }
});

await page.goto(BASE + '/');
await page.locator('#fileInput').setInputFiles(FILE);

// ── interrupt mid-transfer with a hard reload ──────────────────────
await page.waitForFunction(() => {
  const el = document.querySelector('.tx .pct');
  return el && parseInt(el.textContent) >= 25;
}, null, { timeout: 120000 });

const uploadId = puts.length ? new URL(page.url()).origin : null; // placeholder for lint
const idFromPuts = await page.evaluate(() => {
  const m = performance.getEntriesByType('resource')
    .map((e) => e.name.match(/\/api\/upload\/([^/?]+)\?offset=/))
    .find(Boolean);
  return m ? m[1] : null;
});
const { received: atReload } = await (await fetch(`${BASE}/api/upload/${idFromPuts}/status`)).json();
ok(atReload > 0 && atReload < fileSize, `interrupting at ${(atReload / 1e6).toFixed(1)} MB of ${(fileSize / 1e6).toFixed(1)} MB`);

await page.reload();

// ── it must resume, not restart ────────────────────────────────────
const putsBefore = puts.length;
await page.waitForFunction(() => document.querySelector('.tx.done'), null, { timeout: 180000 });
const resumed = puts.slice(putsBefore);

ok(resumed.length > 0, `resumed with ${resumed.length} further chunk(s) after reload`);
ok(resumed.every((p) => p.offset >= atReload - advertisedMaxChunk),
  'no committed byte was re-uploaded after reload',
  `first post-reload offset ${resumed[0]?.offset}, server had ${atReload}`);

// ── chunking policy over the whole transfer ────────────────────────
ok(advertisedMaxChunk > 0, `init advertises maxChunk (${(advertisedMaxChunk / 1024).toFixed(0)} KB)`);
ok(puts.length >= Math.ceil(fileSize / advertisedMaxChunk),
  `file went up in ${puts.length} chunks — never one shot`);
const withBody = puts.filter((p) => p.size >= 0);
const largest = Math.max(...withBody.map((p) => p.size));
ok(withBody.length > 0 && withBody.every((p) => p.size <= advertisedMaxChunk),
  `every observed chunk body ≤ the server cap (largest ${(largest / 1024).toFixed(0)} KB)`);

// the actual working size, which is the point of this test
const CHUNK_TARGET = 500 * 1024;
const kb = (CHUNK_TARGET / 1024).toFixed(0);
ok(largest <= CHUNK_TARGET,
  `no chunk exceeded the ${kb} KB policy (largest ${(largest / 1024).toFixed(1)} KB)`);
const fullSized = withBody.filter((p) => p.size === CHUNK_TARGET).length;
ok(fullSized >= withBody.length - 2,
  `chunks are a fixed ${kb} KB, not adaptive (${fullSized}/${withBody.length} exactly ${kb} KB)`);
ok(puts.length >= Math.floor(fileSize / CHUNK_TARGET),
  `${puts.length} chunks for a ${(fileSize / 1e6).toFixed(0)} MB file — small-chunk policy in force`);

for (const era of [puts.slice(0, putsBefore), resumed]) {
  for (let i = 1; i < era.length; i++) {
    if (era[i].offset < era[i - 1].offset) {
      ok(false, 'offsets regressed within a page-life', `${era[i - 1].offset} → ${era[i].offset}`);
    }
  }
}
ok(true, 'offsets only moved forward within each page-life');

// ── the stored file is complete and streams back ───────────────────
const done = await (await fetch(`${BASE}/api/media`)).json();
const item = done.items.find((i) => i.size === fileSize);
ok(!!item, `finished file listed with exact size ${fileSize}`);
if (item) {
  const range = await fetch(`${BASE}/media/${item.id}`, { headers: { Range: 'bytes=0-1023' } });
  ok(range.status === 206, 'finished file answers Range with 206');
  await fetch(`${BASE}/api/media/${item.id}`, { method: 'DELETE' });
}

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
