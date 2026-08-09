#!/usr/bin/env python3
"""Aperture — Python backend for the 4 GB resumable upload gallery.

Standard library only (no venv, no pip): ThreadingHTTPServer with HTTP/1.1
keep-alive. Chunk bodies are read from the socket in 256 KB blocks straight
into a `.part` file and responses stream back out with byte-range support, so
memory stays flat no matter how large the file is.

Layout under ./data
    tmp/<id>.part     in-flight upload; its length *is* the resume offset
    tmp/<id>.json     declared name/size/type for that upload
    blobs/<id>.<ext>  finished file
    meta/<id>.json    finished metadata
"""

from __future__ import annotations

import json
import os
import re
import signal
import socket
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

MAX_BYTES = 4 * 1024 * 1024 * 1024          # 4 GB
CHUNK_HINT = 1024 * 1024
IO_BLOCK = 256 * 1024

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
TMP, BLOBS, META = DATA / "tmp", DATA / "blobs", DATA / "meta"
PUBLIC = ROOT / "public"

PORT = int(os.environ.get("PORT", "8702"))
HOST = os.environ.get("HOST", "0.0.0.0")
BACKEND = os.environ.get("APERTURE_BACKEND", "Python · http.server")
STARTED = time.time()

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
VIDEO_EXT = {"mp4", "mov", "m4v", "webm", "avi", "mkv", "hevc"}

MIME_BY_EXT = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif",
    "webp": "image/webp", "heic": "image/heic", "heif": "image/heif", "avif": "image/avif",
    "bmp": "image/bmp", "tif": "image/tiff", "tiff": "image/tiff",
    "mp4": "video/mp4", "m4v": "video/mp4", "mov": "video/quicktime",
    "webm": "video/webm", "mkv": "video/x-matroska", "avi": "video/x-msvideo",
}

# one lock per upload id, so two PUTs for the same file cannot interleave
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def lock_for(upload_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(upload_id, threading.Lock())


# ── small helpers ────────────────────────────────────────────────────

def clean_id(raw: str) -> str | None:
    return raw if ID_RE.match(raw or "") else None


def clean_ext(name: str) -> str:
    ext = Path(name).suffix.lstrip(".").lower()
    return "".join(c for c in ext if c.isalnum())[:8]


def kind_of(mime: str, name: str) -> str:
    if mime.startswith("video/"):
        return "video"
    if mime.startswith("image/"):
        return "image"
    return "video" if clean_ext(name) in VIDEO_EXT else "image"


def content_type_for(item: dict) -> str:
    mime = item.get("type") or ""
    if mime.startswith(("image/", "video/")):
        return mime
    return MIME_BY_EXT.get(item.get("ext", ""), "application/octet-stream")


def part_path(i: str) -> Path:
    return TMP / f"{i}.part"


def part_meta_path(i: str) -> Path:
    return TMP / f"{i}.json"


def meta_path(i: str) -> Path:
    return META / f"{i}.json"


def blob_path(item: dict) -> Path:
    ext = item.get("ext") or ""
    return BLOBS / (f"{item['id']}.{ext}" if ext else item["id"])


def size_of(p: Path) -> int:
    try:
        return p.stat().st_size
    except OSError:
        return 0


def read_json(p: Path):
    try:
        with p.open("rb") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def write_json(p: Path, obj) -> None:
    tmp = p.with_suffix(p.suffix + ".swap")
    with tmp.open("wb") as f:
        f.write(json.dumps(obj).encode())
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)


def list_items() -> list[dict]:
    items = []
    for p in META.glob("*.json"):
        item = read_json(p)
        if item and "id" in item:
            items.append(item)
    items.sort(key=lambda i: i.get("ctime", 0), reverse=True)
    return items


def parse_range(raw: str, size: int):
    """`bytes=a-b` / `bytes=a-` / `bytes=-n` -> inclusive (start, end) or None."""
    if not raw or not raw.startswith("bytes=") or size == 0:
        return None
    spec = raw[len("bytes="):].split(",")[0].strip()
    if "-" not in spec:
        return None
    a, b = spec.split("-", 1)
    a, b = a.strip(), b.strip()
    try:
        if not a and not b:
            return None
        if not a:
            n = min(int(b), size)
            start, end = size - n, size - 1
        elif not b:
            start, end = int(a), size - 1
        else:
            start, end = int(a), min(int(b), size - 1)
    except ValueError:
        return None
    if start < 0 or start > end or start >= size:
        return None
    return start, end


class HttpError(Exception):
    def __init__(self, code: int, message: str, **extra):
        super().__init__(message)
        self.code = code
        self.payload = {"error": message, **extra}


# ── request handler ──────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Aperture/1.0"
    sys_version = ""
    timeout = 900                    # a slow 4 GB chunk over a VPN is still valid
    disable_nagle_algorithm = True

    # ── plumbing ─────────────────────────────────────────────────────

    def log_message(self, fmt, *args):
        sys.stdout.write(f"{self.log_date_time_string()} {self.address_string()} {fmt % args}\n")
        sys.stdout.flush()

    def log_request(self, code="-", size="-"):
        # keep the log readable: only note non-2xx and uploads
        if isinstance(code, HTTPStatus):
            code = code.value
        if str(code)[0] not in "23" or self.command in ("PUT", "POST", "DELETE"):
            self.log_message('"%s" %s', self.requestline, code)

    def send_json(self, obj, code: int = 200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_error_json(self, err: HttpError):
        self.send_json(err.payload, err.code)

    def route(self):
        parsed = urlparse(self.path)
        return unquote(parsed.path), parse_qs(parsed.query)

    MAX_SMALL_BODY = 64 * 1024  # JSON/dlog bodies; chunk PUTs stream separately

    def body_bytes(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > self.MAX_SMALL_BODY:
            self.drain(n)
            raise HttpError(413, "request body too large")
        return self.rfile.read(n) if n else b""

    def json_body(self) -> dict:
        try:
            return json.loads(self.body_bytes() or b"{}")
        except (json.JSONDecodeError, ValueError):
            raise HttpError(400, "invalid JSON body")

    # ── dispatch ─────────────────────────────────────────────────────

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method: str):
        path, query = self.route()
        try:
            if method == "GET":
                self.handle_get(path)
            elif method == "POST":
                self.handle_post(path)
            elif method == "PUT":
                self.handle_put(path, query)
            elif method == "DELETE":
                self.handle_delete(path)
        except HttpError as e:
            self.send_error_json(e)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True   # client walked away mid-transfer
        except Exception as e:             # noqa: BLE001 — never take the server down
            self.log_message("unhandled %s %s: %r", method, path, e)
            try:
                self.send_error_json(HttpError(500, f"{type(e).__name__}: {e}"))
            except (BrokenPipeError, ConnectionResetError, OSError):
                self.close_connection = True

    # ── GET ──────────────────────────────────────────────────────────

    def handle_get(self, path: str):
        if path in ("/", "/index.html"):
            return self.serve_asset("index.html", "text/html; charset=utf-8")
        if path == "/styles.css":
            return self.serve_asset("styles.css", "text/css; charset=utf-8")
        if path == "/app.js":
            return self.serve_asset("app.js", "text/javascript; charset=utf-8")

        if path == "/api/health":
            items = list_items()
            return self.send_json({
                "ok": True,
                "backend": BACKEND,
                "language": "python",
                "port": PORT,
                "items": len(items),
                "storedBytes": sum(i.get("size", 0) for i in items),
                "maxBytes": MAX_BYTES,
                "uptime": int(time.time() - STARTED),
            })

        if path == "/api/media":
            return self.send_json({"items": list_items()})

        m = re.fullmatch(r"/api/upload/([^/]+)/status", path)
        if m:
            i = clean_id(m.group(1))
            if not i:
                raise HttpError(400, "invalid upload id")
            item = read_json(meta_path(i))
            if item:
                return self.send_json({"received": item["size"], "done": True})
            return self.send_json({"received": size_of(part_path(i)), "done": False})

        m = re.fullmatch(r"/media/([^/]+)", path)
        if m:
            return self.serve_media(m.group(1))

        raise HttpError(404, "not found")

    def serve_asset(self, name: str, ctype: str):
        p = PUBLIC / name
        try:
            data = p.read_bytes()
        except OSError:
            raise HttpError(404, f"missing public/{name}")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def serve_media(self, raw_id: str):
        i = clean_id(raw_id)
        if not i:
            raise HttpError(400, "invalid id")
        item = read_json(meta_path(i))
        if not item:
            raise HttpError(404, "not found")
        path = blob_path(item)
        size = size_of(path)
        if not path.exists():
            raise HttpError(404, "file missing")

        rng = parse_range(self.headers.get("Range", ""), size)
        start, end = rng if rng else (0, size - 1)
        length = end - start + 1

        self.send_response(206 if rng else 200)
        self.send_header("Content-Type", content_type_for(item))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        if rng:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return

        with path.open("rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                block = f.read(min(IO_BLOCK, left))
                if not block:
                    break
                self.wfile.write(block)
                left -= len(block)

    # ── POST ─────────────────────────────────────────────────────────

    def handle_post(self, path: str):
        if path == "/api/dlog":
            for line in self.body_bytes().decode(errors="replace").splitlines()[:50]:
                clean = "".join(c for c in line if c.isprintable())[:300]
                self.log_message("[phone] %s", clean)
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/api/upload/init":
            return self.upload_init()
        m = re.fullmatch(r"/api/upload/([^/]+)/complete", path)
        if m:
            return self.upload_complete(m.group(1))
        raise HttpError(404, "not found")

    def upload_init(self):
        req = self.json_body()
        i = clean_id(str(req.get("id", "")))
        if not i:
            raise HttpError(400, "invalid upload id")
        try:
            size = int(req.get("size", 0))
        except (TypeError, ValueError):
            raise HttpError(400, "invalid size")
        if size <= 0:
            raise HttpError(400, "file is empty")
        if size > MAX_BYTES:
            raise HttpError(400, f"file exceeds the {MAX_BYTES >> 30} GB limit")

        with lock_for(i):
            done = read_json(meta_path(i))
            if done:
                return self.send_json({"id": i, "received": done["size"], "chunkSize": CHUNK_HINT, "done": True})

            name = "".join(c for c in str(req.get("name", "")) if c not in "/\\")[:255].strip()
            name = name or f"upload-{i}"
            mime = str(req.get("type", ""))[:120]

            write_json(part_meta_path(i), {
                "id": i, "name": name, "size": size, "type": mime,
                "kind": kind_of(mime, name), "ext": clean_ext(name),
            })
            part = part_path(i)
            if not part.exists():
                part.touch()
            received = min(size_of(part), size)

        self.send_json({"id": i, "received": received, "chunkSize": CHUNK_HINT})

    def upload_complete(self, raw_id: str):
        i = clean_id(raw_id)
        if not i:
            raise HttpError(400, "invalid upload id")

        with lock_for(i):
            existing = read_json(meta_path(i))
            if existing:
                return self.send_json({"item": existing})

            decl = read_json(part_meta_path(i))
            if not decl:
                raise HttpError(409, "no upload in progress")
            part = part_path(i)
            have = size_of(part)
            if have != decl["size"]:
                raise HttpError(409, f"incomplete: {have} of {decl['size']} bytes", received=have)

            item = {
                "id": i,
                "name": decl["name"],
                "size": decl["size"],
                "type": decl.get("type", ""),
                "kind": decl.get("kind", "image"),
                "ext": decl.get("ext", ""),
                "ctime": int(time.time() * 1000),
            }
            os.replace(part, blob_path(item))
            write_json(meta_path(i), item)
            part_meta_path(i).unlink(missing_ok=True)

        self.log_message("[upload] %s · %d bytes · %s", item["name"], item["size"], item["kind"])
        self.send_json({"item": item})

    # ── PUT (the chunk itself) ───────────────────────────────────────

    def handle_put(self, path: str, query: dict):
        m = re.fullmatch(r"/api/upload/([^/]+)", path)
        if not m:
            raise HttpError(404, "not found")
        i = clean_id(m.group(1))
        if not i:
            raise HttpError(400, "invalid upload id")
        try:
            offset = int(query.get("offset", ["_"])[0])
        except ValueError:
            raise HttpError(400, "missing ?offset=")
        if offset < 0:
            raise HttpError(400, "negative offset")

        length = int(self.headers.get("Content-Length") or 0)

        with lock_for(i):
            part = part_path(i)
            if not part.exists():
                self.drain(length)
                raise HttpError(409, "no upload in progress — call /init first")
            have = size_of(part)
            if offset != have:
                # never trust the client's idea of the offset; tell it the truth
                self.drain(length)
                raise HttpError(409, f"offset mismatch: server has {have}", received=have)

            decl = read_json(part_meta_path(i)) or {}
            declared = min(int(decl.get("size", MAX_BYTES)), MAX_BYTES)
            if offset + length > declared:
                self.drain(length)
                raise HttpError(400, "chunk would exceed the declared file size")

            written = offset
            with part.open("r+b") as f:
                f.seek(offset)
                left = length
                while left > 0:
                    block = self.rfile.read(min(IO_BLOCK, left))
                    if not block:
                        break                       # connection died mid-chunk
                    f.write(block)
                    written += len(block)
                    left -= len(block)
                f.flush()
                os.fsync(f.fileno())
                f.truncate(written)

            if written != offset + length:
                self.close_connection = True
                raise HttpError(400, "stream interrupted", received=written)

        self.send_json({"received": written})

    def drain(self, n: int) -> None:
        """Swallow a body we are about to reject so keep-alive stays usable."""
        left = n
        while left > 0:
            block = self.rfile.read(min(IO_BLOCK, left))
            if not block:
                break
            left -= len(block)

    # ── DELETE ───────────────────────────────────────────────────────

    def handle_delete(self, path: str):
        m = re.fullmatch(r"/api/upload/([^/]+)", path)
        if m:
            i = clean_id(m.group(1))
            if not i:
                raise HttpError(400, "invalid upload id")
            with lock_for(i):
                part_path(i).unlink(missing_ok=True)
                part_meta_path(i).unlink(missing_ok=True)
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        m = re.fullmatch(r"/api/media/([^/]+)", path)
        if m:
            i = clean_id(m.group(1))
            if not i:
                raise HttpError(400, "invalid id")
            item = read_json(meta_path(i))
            if not item:
                raise HttpError(404, "not found")
            blob_path(item).unlink(missing_ok=True)
            meta_path(i).unlink(missing_ok=True)
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        raise HttpError(404, "not found")


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128

    def server_bind(self):
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, TimeoutError)):
            return  # normal when a browser aborts a video range request
        super().handle_error(request, client_address)


def main() -> None:
    for d in (DATA, TMP, BLOBS, META):
        d.mkdir(parents=True, exist_ok=True)

    try:
        httpd = Server((HOST, PORT), Handler)
    except OSError as e:
        print(f"cannot bind {HOST}:{PORT}: {e}", file=sys.stderr)
        sys.exit(1)

    # the supervisor stops us with SIGTERM; unwind in-flight writes cleanly
    def on_term(_sig, _frame):
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, on_term)

    print(f"aperture [{BACKEND}] listening on http://{HOST}:{PORT}", flush=True)
    print(f"storage: {DATA}", flush=True)
    try:
        httpd.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        pass
    finally:
        print("shutting down …", flush=True)
        httpd.shutdown()
        httpd.server_close()
        print("aperture stopped", flush=True)


if __name__ == "__main__":
    main()
