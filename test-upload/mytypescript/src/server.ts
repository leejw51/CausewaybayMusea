/**
 * Aperture — TypeScript/Node backend for the 4 GB resumable upload gallery.
 *
 * Zero runtime dependencies: node:http only. Chunk bodies are piped straight
 * from the socket into a `.part` file and reads stream back out with byte-range
 * support, so RSS stays flat regardless of file size.
 *
 * Layout under ./data
 *   tmp/<id>.part      in-flight upload; its length *is* the resume offset
 *   tmp/<id>.json      declared name/size/type for that upload
 *   blobs/<id>.<ext>   finished file
 *   meta/<id>.json     finished metadata
 */

import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
const CHUNK_HINT = 1024 * 1024;
const IO_BLOCK = 256 * 1024;

const PORT = Number(process.env['PORT'] ?? 8703);
const HOST = process.env['HOST'] ?? '0.0.0.0';
const BACKEND = process.env['APERTURE_BACKEND'] ?? 'TypeScript · node:http';
const STARTED = Date.now();

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const TMP = path.join(DATA, 'tmp');
const BLOBS = path.join(DATA, 'blobs');
const META = path.join(DATA, 'meta');
const PUBLIC = path.join(ROOT, 'public');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', 'hevc']);

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
};

interface Item {
  id: string;
  name: string;
  size: number;
  type: string;
  kind: 'image' | 'video';
  ext: string;
  ctime: number;
}

interface PendingMeta {
  id: string;
  name: string;
  size: number;
  type: string;
  kind: 'image' | 'video';
  ext: string;
}

class HttpError extends Error {
  constructor(readonly code: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
  get payload() {
    return { error: this.message, ...this.extra };
  }
}

// ── per-upload serialization ─────────────────────────────────────────
// Two PUTs for one id must not interleave, so each id gets a promise chain.

const chains = new Map<string, Promise<unknown>>();

function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(id, next.then(() => undefined, () => undefined));
  return next;
}

// ── helpers ──────────────────────────────────────────────────────────

function cleanId(raw: string | undefined): string {
  if (!raw || !ID_RE.test(raw)) throw new HttpError(400, 'invalid upload id');
  return raw;
}

function cleanExt(name: string): string {
  const ext = path.extname(name).replace('.', '').toLowerCase();
  return ext.replace(/[^a-z0-9]/g, '').slice(0, 8);
}

function kindOf(mime: string, name: string): 'image' | 'video' {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  return VIDEO_EXT.has(cleanExt(name)) ? 'video' : 'image';
}

function contentTypeFor(item: Item): string {
  if (item.type.startsWith('image/') || item.type.startsWith('video/')) return item.type;
  return MIME_BY_EXT[item.ext] ?? 'application/octet-stream';
}

const partPath = (id: string) => path.join(TMP, `${id}.part`);
const partMetaPath = (id: string) => path.join(TMP, `${id}.json`);
const metaPath = (id: string) => path.join(META, `${id}.json`);
const blobPath = (item: Item | PendingMeta) =>
  path.join(BLOBS, item.ext ? `${item.id}.${item.ext}` : item.id);

async function sizeOf(p: string): Promise<number> {
  try {
    return (await fsp.stat(p)).size;
  } catch {
    return 0;
  }
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(p: string, obj: unknown): Promise<void> {
  const swap = `${p}.swap`;
  await fsp.writeFile(swap, JSON.stringify(obj));
  await fsp.rename(swap, p);
}

async function listItems(): Promise<Item[]> {
  let names: string[];
  try {
    names = await fsp.readdir(META);
  } catch {
    return [];
  }
  const items: Item[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const item = await readJson<Item>(path.join(META, n));
    if (item?.id) items.push(item);
  }
  return items.sort((a, b) => b.ctime - a.ctime);
}

/** `bytes=a-b` / `bytes=a-` / `bytes=-n` -> inclusive [start, end] or null. */
function parseRange(raw: string | undefined, size: number): [number, number] | null {
  if (!raw?.startsWith('bytes=') || size === 0) return null;
  const spec = raw.slice(6).split(',')[0]?.trim();
  if (!spec || !spec.includes('-')) return null;
  const dash = spec.indexOf('-');
  const a = spec.slice(0, dash).trim();
  const b = spec.slice(dash + 1).trim();
  let start: number;
  let end: number;
  if (!a && !b) return null;
  if (!a) {
    const n = Math.min(Number(b), size);
    if (!Number.isFinite(n)) return null;
    start = size - n;
    end = size - 1;
  } else if (!b) {
    start = Number(a);
    end = size - 1;
  } else {
    start = Number(a);
    end = Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start > end || start >= size) return null;
  return [start, end];
}

function sendJson(res: http.ServerResponse, obj: unknown, code = 200): void {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}

/** Swallow a body we are about to reject so the keep-alive socket stays usable. */
function drain(req: http.IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.resume();
    req.on('end', resolve);
    req.on('error', () => resolve());
    req.on('close', () => resolve());
  });
}

function readJsonBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > limit) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => {
      try {
        resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', (e) => reject(new HttpError(400, `body read failed: ${e.message}`)));
  });
}

// ── handlers ─────────────────────────────────────────────────────────

async function serveAsset(res: http.ServerResponse, name: string, ctype: string): Promise<void> {
  let data: Buffer;
  try {
    data = await fsp.readFile(path.join(PUBLIC, name));
  } catch {
    throw new HttpError(404, `missing public/${name}`);
  }
  res.writeHead(200, {
    'Content-Type': ctype,
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  res.end(data);
}

async function health(res: http.ServerResponse): Promise<void> {
  const items = await listItems();
  sendJson(res, {
    ok: true,
    backend: BACKEND,
    language: 'typescript',
    port: PORT,
    items: items.length,
    storedBytes: items.reduce((a, i) => a + i.size, 0),
    maxBytes: MAX_BYTES,
    uptime: Math.floor((Date.now() - STARTED) / 1000),
  });
}

async function uploadInit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const id = cleanId(typeof body['id'] === 'string' ? body['id'] : undefined);
  const size = Number(body['size']);
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, 'file is empty');
  if (size > MAX_BYTES) throw new HttpError(400, `file exceeds the ${MAX_BYTES / 2 ** 30} GB limit`);

  const result = await withLock(id, async () => {
    const done = await readJson<Item>(metaPath(id));
    if (done) return { id, received: done.size, chunkSize: CHUNK_HINT, done: true };

    const rawName = typeof body['name'] === 'string' ? body['name'] : '';
    const name = rawName.replace(/[/\\]/g, '').slice(0, 255).trim() || `upload-${id}`;
    const type = (typeof body['type'] === 'string' ? body['type'] : '').slice(0, 120);

    const pending: PendingMeta = { id, name, size, type, kind: kindOf(type, name), ext: cleanExt(name) };
    await writeJson(partMetaPath(id), pending);

    const part = partPath(id);
    try {
      await fsp.access(part);
    } catch {
      await fsp.writeFile(part, '');
    }
    return { id, received: Math.min(await sizeOf(part), size), chunkSize: CHUNK_HINT };
  });

  sendJson(res, result);
}

async function uploadStatus(res: http.ServerResponse, rawId: string | undefined): Promise<void> {
  const id = cleanId(rawId);
  const done = await readJson<Item>(metaPath(id));
  if (done) return sendJson(res, { received: done.size, done: true });
  sendJson(res, { received: await sizeOf(partPath(id)), done: false });
}

async function uploadChunk(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawId: string | undefined,
  url: URL,
): Promise<void> {
  const id = cleanId(rawId);
  const offset = Number(url.searchParams.get('offset'));
  if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'missing ?offset=');
  const declaredLen = Number(req.headers['content-length'] ?? 0);

  const result = await withLock(id, async () => {
    const part = partPath(id);
    try {
      await fsp.access(part);
    } catch {
      await drain(req);
      throw new HttpError(409, 'no upload in progress — call /init first');
    }

    const have = await sizeOf(part);
    if (offset !== have) {
      // never trust the client's idea of the offset; hand back the truth
      await drain(req);
      throw new HttpError(409, `offset mismatch: server has ${have}`, { received: have });
    }

    const pending = await readJson<PendingMeta>(partMetaPath(id));
    const declared = Math.min(pending?.size ?? MAX_BYTES, MAX_BYTES);
    if (offset + declaredLen > declared) {
      await drain(req);
      throw new HttpError(400, 'chunk would exceed the declared file size');
    }

    // Positional writes rather than a piped write stream: the socket is the
    // only backpressure source we need, and this keeps `written` exact even
    // when the connection dies halfway through the chunk.
    const fh = await fsp.open(part, 'r+');
    let written = offset;
    try {
      try {
        for await (const block of req) {
          const buf = block as Buffer;
          await fh.write(buf, 0, buf.length, written);
          written += buf.length;
        }
      } catch (err) {
        // socket died mid-chunk: keep whatever landed, the client resumes here
        await fh.truncate(written);
        await fh.sync();
        throw new HttpError(400, `stream interrupted: ${(err as Error).message}`, { received: written });
      }
      await fh.truncate(written);
      await fh.sync();
    } finally {
      await fh.close();
    }

    if (declaredLen && written !== offset + declaredLen) {
      throw new HttpError(400, 'short chunk', { received: written });
    }
    return { received: written };
  });

  sendJson(res, result);
}

async function uploadComplete(res: http.ServerResponse, rawId: string | undefined): Promise<void> {
  const id = cleanId(rawId);
  const item = await withLock(id, async () => {
    const existing = await readJson<Item>(metaPath(id));
    if (existing) return existing;

    const pending = await readJson<PendingMeta>(partMetaPath(id));
    if (!pending) throw new HttpError(409, 'no upload in progress');

    const part = partPath(id);
    const have = await sizeOf(part);
    if (have !== pending.size) {
      throw new HttpError(409, `incomplete: ${have} of ${pending.size} bytes`, { received: have });
    }

    const finished: Item = { ...pending, ctime: Date.now() };
    await fsp.rename(part, blobPath(finished));
    await writeJson(metaPath(id), finished);
    await fsp.rm(partMetaPath(id), { force: true });
    console.log(`[upload] ${finished.name} · ${finished.size} bytes · ${finished.kind}`);
    return finished;
  });

  sendJson(res, { item });
}

async function uploadAbort(res: http.ServerResponse, rawId: string | undefined): Promise<void> {
  const id = cleanId(rawId);
  await withLock(id, async () => {
    await fsp.rm(partPath(id), { force: true });
    await fsp.rm(partMetaPath(id), { force: true });
  });
  res.writeHead(204, { 'Content-Length': 0 });
  res.end();
}

async function mediaDelete(res: http.ServerResponse, rawId: string | undefined): Promise<void> {
  const id = cleanId(rawId);
  const item = await readJson<Item>(metaPath(id));
  if (!item) throw new HttpError(404, 'not found');
  await fsp.rm(blobPath(item), { force: true });
  await fsp.rm(metaPath(id), { force: true });
  res.writeHead(204, { 'Content-Length': 0 });
  res.end();
}

async function mediaServe(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawId: string | undefined,
): Promise<void> {
  const id = cleanId(rawId);
  const item = await readJson<Item>(metaPath(id));
  if (!item) throw new HttpError(404, 'not found');

  const file = blobPath(item);
  const size = await sizeOf(file);
  if (!size) throw new HttpError(404, 'file missing');

  const range = parseRange(req.headers.range, size);
  const [start, end] = range ?? [0, size - 1];

  res.writeHead(range ? 206 : 200, {
    'Content-Type': contentTypeFor(item),
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(file, { start, end, highWaterMark: IO_BLOCK });
  try {
    await pipeline(stream, res);
  } catch {
    // the browser aborting a video range request is routine, not an error
    stream.destroy();
  }
}

// ── router ───────────────────────────────────────────────────────────

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const p = decodeURIComponent(url.pathname);
  const method = req.method ?? 'GET';

  if (method === 'GET' || method === 'HEAD') {
    if (p === '/' || p === '/index.html') return serveAsset(res, 'index.html', 'text/html; charset=utf-8');
    if (p === '/styles.css') return serveAsset(res, 'styles.css', 'text/css; charset=utf-8');
    if (p === '/app.js') return serveAsset(res, 'app.js', 'text/javascript; charset=utf-8');
    if (p === '/api/health') return health(res);
    if (p === '/api/media') return sendJson(res, { items: await listItems() });

    let m = /^\/api\/upload\/([^/]+)\/status$/.exec(p);
    if (m) return uploadStatus(res, m[1]);

    m = /^\/media\/([^/]+)$/.exec(p);
    if (m) return mediaServe(req, res, m[1]);
  }

  if (method === 'POST') {
    if (p === '/api/dlog') {
      await new Promise<void>((resolve) => {
        const parts: Buffer[] = [];
        let total = 0;
        req.on('data', (c: Buffer) => {
          total += c.length;
          if (total > 64 * 1024) { req.destroy(); resolve(); return; } // cap: log spam is not a memory lever
          parts.push(c);
        });
        req.on('end', () => {
          for (const line of Buffer.concat(parts).toString('utf8').split('\n').slice(0, 50)) {
            const clean = line.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 300);
            if (clean.trim()) console.log('[phone]', clean);
          }
          resolve();
        });
        req.on('error', () => resolve());
      });
      res.writeHead(204, { 'Content-Length': 0 });
      res.end();
      return;
    }
    if (p === '/api/upload/init') return uploadInit(req, res);
    const m = /^\/api\/upload\/([^/]+)\/complete$/.exec(p);
    if (m) return uploadComplete(res, m[1]);
  }

  if (method === 'PUT') {
    const m = /^\/api\/upload\/([^/]+)$/.exec(p);
    if (m) return uploadChunk(req, res, m[1], url);
  }

  if (method === 'DELETE') {
    let m = /^\/api\/upload\/([^/]+)$/.exec(p);
    if (m) return uploadAbort(res, m[1]);
    m = /^\/api\/media\/([^/]+)$/.exec(p);
    if (m) return mediaDelete(res, m[1]);
  }

  throw new HttpError(404, 'not found');
}

// ── server ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  for (const d of [DATA, TMP, BLOBS, META]) await fsp.mkdir(d, { recursive: true });

  const server = http.createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) return sendJson(res, err.payload, err.code);
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ECONNRESET' || e.code === 'EPIPE') {
        res.destroy();
        return;
      }
      console.error(`unhandled ${req.method} ${req.url}:`, err);
      sendJson(res, { error: `${(err as Error).name}: ${(err as Error).message}` }, 500);
    });
  });

  // A 4 GB upload over a VPN is legitimately slow; Node's 5-minute default
  // request timeout would kill perfectly healthy chunks.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 120_000;
  server.keepAliveTimeout = 75_000;
  server.maxRequestsPerSocket = 0;

  server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  server.listen(PORT, HOST, () => {
    console.log(`aperture [${BACKEND}] listening on http://${HOST}:${PORT}`);
    console.log(`storage: ${DATA}`);
  });

  server.on('error', (err) => {
    console.error(`cannot bind ${HOST}:${PORT}: ${err.message}`);
    process.exit(1);
  });

  const shutdown = () => {
    console.log('shutting down …');
    server.close(() => {
      console.log('aperture stopped');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
