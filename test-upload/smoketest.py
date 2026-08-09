#!/usr/bin/env python3
"""End-to-end check of the Aperture chunked upload API.

    ./smoketest.py <port> [size_mb]
    ./smoketest.py all                # 8701 + 8702 + 8703

Drives the exact protocol the browser uses, including the failure modes that
actually bite on a phone over a VPN:

  1  /api/health responds
  2  init returns a resume offset
  3  a wrong offset is rejected with 409 and the server's true offset
  4  a chunk cut off mid-flight keeps its partial bytes  ← the resume case
  5  /status reports that partial offset
  6  the upload resumes from there and finishes
  7  complete moves it into the library
  8  a full GET returns byte-identical data (sha256)
  9  Accept-Ranges + three flavours of Range request
 10  HEAD returns headers without a body
 11  concurrent range reads do not interfere
 12  bad ids / unknown ids are rejected, not crashed on
 13  delete removes it
"""

from __future__ import annotations

import hashlib
import json
import random
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

G = "\033[32m"; R = "\033[31m"; Y = "\033[33m"; D = "\033[2m"; B = "\033[1m"; N = "\033[0m"
if not sys.stdout.isatty():
    G = R = Y = D = B = N = ""

HOST = "127.0.0.1"


class Report:
    def __init__(self):
        self.passed = 0
        self.failed = 0

    def ok(self, msg):
        self.passed += 1
        print(f"{G}✓{N} {msg}", flush=True)

    def bad(self, msg):
        self.failed += 1
        print(f"{R}✗{N} {msg}", flush=True)

    def note(self, msg):
        print(f"{D}·{N} {msg}", flush=True)

    def check(self, cond, good_msg, bad_msg):
        self.ok(good_msg) if cond else self.bad(bad_msg)
        return cond


def call(base, path, method="GET", body=None, headers=None, raw=False, timeout=120):
    req = urllib.request.Request(base + path, data=body, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
            # r.headers is case-insensitive; keep it rather than dict()-ing it
            return r.status, r.headers, (data if raw else (json.loads(data) if data else None))
    except urllib.error.HTTPError as e:
        data = e.read()
        try:
            return e.code, e.headers, json.loads(data)
        except (json.JSONDecodeError, ValueError):
            return e.code, e.headers, {"error": data[:200].decode(errors="replace")}


def truncated_put(port, upload_id, offset, payload, send_bytes):
    """PUT that promises `len(payload)` bytes then hangs up after `send_bytes`.

    This is what a phone walking out of Wi-Fi range looks like to the server.
    """
    s = socket.create_connection((HOST, port), timeout=30)
    try:
        head = (
            f"PUT /api/upload/{upload_id}?offset={offset} HTTP/1.1\r\n"
            f"Host: {HOST}:{port}\r\n"
            f"Content-Type: application/octet-stream\r\n"
            f"Content-Length: {len(payload)}\r\n"
            f"Connection: close\r\n\r\n"
        ).encode()
        s.sendall(head)
        s.sendall(payload[:send_bytes])
        time.sleep(0.5)          # let the server flush what arrived to disk
        s.shutdown(socket.SHUT_WR)  # clean FIN: premature end of body
        time.sleep(0.5)
    finally:
        s.close()


def run(port: int, size_mb: float) -> Report:
    rep = Report()
    base = f"http://{HOST}:{port}"
    size = int(size_mb * 1024 * 1024)

    print(f"\n{B}━━ smoketest {base} · {size_mb:g} MB payload{N}\n")

    # 1 ─ health -------------------------------------------------------
    status, _, health = call(base, "/api/health", timeout=10)
    if status != 200:
        rep.bad(f"/api/health returned {status} — is the server up? (make start)")
        return rep
    rep.ok(f"health: {health.get('backend')} · {health.get('language')} · {health.get('items')} items stored")

    random.seed(1234)
    payload = random.randbytes(size)
    digest = hashlib.sha256(payload).hexdigest()
    upload_id = "smoke" + hashlib.sha1(f"{size}-{port}".encode()).hexdigest()[:12]
    name = f"smoketest-{size_mb:g}mb.mp4"
    init_body = json.dumps({"id": upload_id, "name": name, "size": size, "type": "video/mp4"}).encode()
    json_hdr = {"Content-Type": "application/json"}
    bin_hdr = {"Content-Type": "application/octet-stream"}

    # start from a clean slate so reruns are deterministic
    call(base, f"/api/upload/{upload_id}", "DELETE")
    call(base, f"/api/media/{upload_id}", "DELETE")

    # 2 ─ init ---------------------------------------------------------
    status, _, init = call(base, "/api/upload/init", "POST", init_body, json_hdr)
    if status != 200:
        rep.bad(f"init failed: {status} {init}")
        return rep
    rep.check(init["received"] == 0,
              f"init → received=0 chunkSize={init.get('chunkSize')}",
              f"init should start at 0, got {init['received']}")

    # 3 ─ a wrong offset must be refused -------------------------------
    status, _, body = call(base, f"/api/upload/{upload_id}?offset=999999", "PUT", b"x" * 16, bin_hdr)
    rep.check(status == 409 and body.get("received") == 0,
              f"wrong offset rejected with 409, server reports received={body.get('received')}",
              f"wrong offset should be 409 with the true offset, got {status} {body}")

    # 4 ─ interrupted chunk keeps its partial bytes ---------------------
    chunk = min(4 * 1024 * 1024, size)
    half = chunk // 2
    rep.note(f"cutting the connection {half >> 10} KB into a {chunk >> 20} MB chunk …")
    try:
        truncated_put(port, upload_id, 0, payload[:chunk], half)
    except OSError as e:
        rep.bad(f"truncated PUT could not run: {e}")

    status, _, st = call(base, f"/api/upload/{upload_id}/status", timeout=15)
    partial = st.get("received", -1) if status == 200 else -1
    rep.check(partial == half,
              f"interrupted chunk kept exactly {partial} bytes — resumable",
              f"after the cut the server reports {partial}, expected {half}")

    # 5 ─ resume from wherever the server actually is -------------------
    sent = partial if partial > 0 else 0
    status, _, body = call(base, f"/api/upload/{upload_id}?offset={sent}", "PUT",
                           payload[sent:chunk], bin_hdr)
    rep.check(status == 200 and body.get("received") == chunk,
              f"resumed at {sent} and completed the chunk → {body.get('received')}",
              f"resume failed: {status} {body}")
    sent = body.get("received", sent) if status == 200 else sent

    # 6 ─ stream the rest ----------------------------------------------
    t0 = time.time()
    while sent < size:
        end = min(sent + chunk, size)
        status, _, body = call(base, f"/api/upload/{upload_id}?offset={sent}", "PUT",
                               payload[sent:end], bin_hdr, timeout=600)
        if status != 200:
            rep.bad(f"chunk at {sent} failed: {status} {body}")
            return rep
        sent = body["received"]
        print(f"\r  {D}uploading {sent * 100 // size:3d}%  {sent >> 20} / {size >> 20} MB{N}", end="", flush=True)
    dt = max(time.time() - t0, 1e-6)
    print()
    rep.ok(f"uploaded {size >> 20} MB in {dt:.2f}s ({(size / dt) / (1 << 20):.0f} MB/s on loopback)")

    status, _, st = call(base, f"/api/upload/{upload_id}/status")
    rep.check(status == 200 and st["received"] == size,
              f"status reports the full {size} bytes",
              f"status disagrees: {status} {st}")

    # 7 ─ complete ------------------------------------------------------
    status, _, res = call(base, f"/api/upload/{upload_id}/complete", "POST", timeout=60)
    if status != 200:
        rep.bad(f"complete failed: {status} {res}")
        return rep
    item = res["item"]
    rep.check(item["size"] == size and item["kind"] == "video",
              f"completed → id={item['id']} kind={item['kind']} size={item['size']}",
              f"completed with wrong metadata: {item}")

    # completing twice must be harmless (the client may retry)
    status, _, again = call(base, f"/api/upload/{upload_id}/complete", "POST")
    rep.check(status == 200 and again["item"]["id"] == item["id"],
              "completing twice is idempotent",
              f"second complete returned {status} {again}")

    # 8 ─ full read-back -------------------------------------------------
    status, headers, data = call(base, f"/media/{item['id']}", raw=True, timeout=600)
    if status != 200:
        rep.bad(f"GET /media returned {status}")
    else:
        rep.check(hashlib.sha256(data).hexdigest() == digest,
                  f"full GET is byte-identical (sha256 {digest[:16]}…), type={headers.get('Content-Type')}",
                  f"round-trip corrupted: {len(data)} bytes back, sha mismatch")

    rep.check(headers.get("Accept-Ranges") == "bytes",
              "Accept-Ranges: bytes advertised",
              "Accept-Ranges missing — iOS video scrubbing will not work")

    # 9 ─ ranged reads ---------------------------------------------------
    for label, hdr, want in [
        ("mid-range", "bytes=1048576-2097151", payload[1048576:2097152]),
        ("open-ended tail", f"bytes={size - 4096}-", payload[size - 4096:]),
        ("suffix", "bytes=-2048", payload[-2048:]),
        ("first byte", "bytes=0-0", payload[:1]),
    ]:
        status, headers, data = call(base, f"/media/{item['id']}", headers={"Range": hdr}, raw=True)
        if status != 206:
            rep.bad(f"{label}: expected 206, got {status}")
        elif data != want:
            rep.bad(f"{label}: got {len(data)} bytes, expected {len(want)} and they differ")
        else:
            rep.ok(f"{label} ok — {headers.get('Content-Range')}")

    status, _, _ = call(base, f"/media/{item['id']}", headers={"Range": "bytes=99999999999-"}, raw=True)
    rep.check(status in (200, 416),
              f"an unsatisfiable range is handled gracefully ({status})",
              f"unsatisfiable range returned {status}")

    # 10 ─ HEAD ----------------------------------------------------------
    status, headers, data = call(base, f"/media/{item['id']}", "HEAD", raw=True)
    rep.check(status == 200 and not data and headers.get("Content-Length") == str(size),
              f"HEAD returns Content-Length {size} and no body",
              f"HEAD misbehaved: {status} len={len(data or b'')} cl={headers.get('Content-Length')}")

    # 11 ─ concurrent range reads ----------------------------------------
    results: list[bool] = []
    lock = threading.Lock()

    def grab(i: int):
        start = (size // 8) * i
        end = start + 65535
        st, _, d = call(base, f"/media/{item['id']}", headers={"Range": f"bytes={start}-{end}"}, raw=True)
        with lock:
            results.append(st == 206 and d == payload[start:end + 1])

    threads = [threading.Thread(target=grab, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    rep.check(len(results) == 8 and all(results),
              "8 concurrent range reads all returned the right bytes",
              f"concurrent reads disagreed: {results}")

    # 12 ─ hostile input --------------------------------------------------
    status, _, _ = call(base, "/api/upload/..%2F..%2Fetc%2Fpasswd/status")
    rep.check(status in (400, 404),
              f"a path-traversal id is rejected ({status})",
              f"path traversal returned {status} — should be 400/404")

    status, _, _ = call(base, "/media/doesnotexist", raw=True)
    rep.check(status == 404, "unknown id → 404", f"unknown id returned {status}")

    # size limit comes from the backend itself, so the same test drives a
    # 4 GB python/ts backend and the 1 TB rust backend
    _, _, health = call(base, "/api/health")
    max_bytes = int(health.get("maxBytes", 4 * 1024**3))

    status, _, _ = call(base, "/api/upload/init", "POST",
                        json.dumps({"id": "sizetest", "name": "x.mp4", "size": max_bytes + 1}).encode(), json_hdr)
    rep.check(status == 400, f"a file over the {max_bytes >> 30} GB limit is refused at init",
              f"oversize init returned {status}")

    status, _, body = call(base, "/api/upload/init", "POST",
                        json.dumps({"id": "sizetest2", "name": "big.mp4", "size": max_bytes}).encode(), json_hdr)
    rep.check(status == 200, f"a file of exactly {max_bytes >> 30} GB is accepted at init",
              f"max-size init returned {status}")
    call(base, "/api/upload/sizetest2", "DELETE")

    # backends that advertise a per-PUT chunk cap must enforce it mid-stream
    if isinstance(body, dict) and body.get("maxChunk"):
        max_chunk = int(body["maxChunk"])
        cid = "chunkcaptest"
        call(base, f"/api/upload/{cid}", "DELETE")
        call(base, "/api/upload/init", "POST",
             json.dumps({"id": cid, "name": "c.mp4", "size": max_chunk * 4}).encode(), json_hdr)
        # raw socket: the server answers 413 and stops reading while we are
        # still writing, so a buffered client would just see a broken pipe
        chost, cport = base.split("//", 1)[1].split(":")
        oversize = max_chunk + 1024
        csock = socket.create_connection((chost, int(cport)), timeout=20)
        cstatus = ""
        try:
            csock.sendall(
                f"PUT /api/upload/{cid}?offset=0 HTTP/1.1\r\nHost: {chost}\r\n"
                f"Content-Type: application/octet-stream\r\n"
                f"Content-Length: {oversize}\r\n\r\n".encode()
            )
            blk = b"\x00" * 65536
            sent = 0
            while sent < oversize:
                csock.sendall(blk[: min(len(blk), oversize - sent)])
                sent += min(len(blk), oversize - sent)
        except OSError:
            pass  # expected: server rejected and stopped reading
        try:
            head = csock.recv(200).decode(errors="replace")
            cstatus = head.split("\r\n", 1)[0]
        except OSError:
            pass
        csock.close()
        rep.check("413" in cstatus,
                  f"a chunk over {max_chunk >> 10} KB is rejected with 413",
                  f"oversize chunk returned {cstatus!r}")
        _, _, st2 = call(base, f"/api/upload/{cid}/status")
        rep.check(st2.get("received") == 0, "rejected oversize chunk leaves offset at 0",
                  f"offset after oversize chunk: {st2.get('received')}")
        call(base, f"/api/upload/{cid}", "DELETE")

    # ── many small chunks over ONE keep-alive connection ──────────────
    # A browser reuses a single connection for consecutive chunk PUTs. At a
    # 100 KB chunk size that path carries the entire transfer, so it has to
    # survive far more than a couple of round trips.
    host, port = base.split("//", 1)[1].split(":")
    kid = "keepalive-many"
    call(base, f"/api/upload/{kid}", "DELETE")
    n_chunks, csize = 40, 500 * 1024
    call(base, "/api/upload/init", "POST",
         json.dumps({"id": kid, "name": "ka.mp4", "size": n_chunks * csize}).encode(), json_hdr)

    sock = socket.create_connection((host, int(port)), timeout=20)
    reused_ok, first_failure = 0, None
    try:
        for n in range(n_chunks):
            payload = bytes([n % 256]) * csize
            sock.sendall(
                f"PUT /api/upload/{kid}?offset={n * csize} HTTP/1.1\r\nHost: {host}\r\n"
                f"Content-Type: application/octet-stream\r\n"
                f"Content-Length: {csize}\r\n\r\n".encode() + payload
            )
            head = b""
            while b"\r\n\r\n" not in head:
                d = sock.recv(4096)
                if not d:
                    break
                head += d
            if not head:
                first_failure = f"connection closed at chunk {n + 1}"
                break
            status_line = head.split(b"\r\n", 1)[0].decode(errors="replace")
            if " 200 " not in status_line:
                first_failure = f"chunk {n + 1} returned {status_line}"
                break
            # drain the JSON body so the next request starts clean
            clen = 0
            for line in head.split(b"\r\n\r\n", 1)[0].split(b"\r\n")[1:]:
                if line.lower().startswith(b"content-length:"):
                    clen = int(line.split(b":")[1])
            body_seen = len(head.split(b"\r\n\r\n", 1)[1])
            while body_seen < clen:
                body_seen += len(sock.recv(4096))
            reused_ok += 1
    except OSError as e:
        first_failure = f"{type(e).__name__} at chunk {reused_ok + 1}: {e}"
    finally:
        sock.close()

    rep.check(reused_ok == n_chunks,
              f"{n_chunks} consecutive {csize >> 10} KB chunks on one keep-alive connection",
              first_failure or f"only {reused_ok}/{n_chunks} succeeded")
    _, _, kst = call(base, f"/api/upload/{kid}/status")
    rep.check(kst.get("received") == n_chunks * csize,
              "keep-alive run committed every byte in order",
              f"server has {kst.get('received')} of {n_chunks * csize}")
    call(base, f"/api/upload/{kid}", "DELETE")

    # ── a wedged chunk must not block the next one ────────────────────
    # A phone that backgrounds or drops off the VPN leaves the socket OPEN and
    # stops sending — no FIN, no reset. If the handler waits forever holding
    # the per-upload lock, every retry queues behind a request that will never
    # finish and only a page reload recovers it. That was a real bug in all
    # three backends; this pins it shut.
    wid = "wedgetest"
    call(base, f"/api/upload/{wid}", "DELETE")
    call(base, "/api/upload/init", "POST",
         json.dumps({"id": wid, "name": "w.mp4", "size": 8 * 1024 * 1024}).encode(), json_hdr)

    wedge = socket.create_connection((host, int(port)), timeout=30)
    wedge.sendall(
        f"PUT /api/upload/{wid}?offset=0 HTTP/1.1\r\nHost: {host}\r\n"
        f"Content-Type: application/octet-stream\r\n"
        f"Content-Length: {4 * 1024 * 1024}\r\n\r\n".encode()
    )
    wedge.sendall(b"\x00" * (512 * 1024))   # part of the promised body, then silence
    time.sleep(1.0)

    rep.note("a chunk went silent mid-body; the next chunk must not hang …")
    t_probe = time.time()
    pstatus, _, _ = call(base, f"/api/upload/{wid}?offset={512 * 1024}", "PUT",
                         b"\x01" * (256 * 1024), bin_hdr, timeout=90)
    probe_s = time.time() - t_probe
    # it may legitimately wait out the server's idle timeout (~20s), but it
    # must not wait forever — before the fix this never returned at all
    rep.check(probe_s < 60,
              f"a wedged chunk released the lock in {probe_s:.0f}s (status {pstatus})",
              f"next chunk still blocked after {probe_s:.0f}s — the lock is wedged")
    try:
        wedge.close()
    except OSError:
        pass
    call(base, f"/api/upload/{wid}", "DELETE")

    # 13 ─ listing and delete ---------------------------------------------
    status, _, lst = call(base, "/api/media")
    rep.check(status == 200 and any(i["id"] == item["id"] for i in lst["items"]),
              f"present in /api/media ({len(lst['items'])} items)",
              "uploaded item missing from /api/media")

    status, _, _ = call(base, f"/api/media/{item['id']}", "DELETE")
    rep.check(status in (200, 204), "deleted", f"delete returned {status}")

    status, _, _ = call(base, f"/media/{item['id']}", raw=True)
    rep.check(status == 404, "gone after delete", f"still served after delete ({status})")

    return rep


def main() -> None:
    arg = sys.argv[1] if len(sys.argv) > 1 else "8701"
    size_mb = float(sys.argv[2]) if len(sys.argv) > 2 else 24
    ports = [8701, 8702, 8703] if arg == "all" else [int(arg)]

    reports = {p: run(p, size_mb) for p in ports}

    total_pass = sum(r.passed for r in reports.values())
    total_fail = sum(r.failed for r in reports.values())
    print()
    if len(ports) > 1:
        for p, r in reports.items():
            mark = f"{G}PASS{N}" if r.failed == 0 else f"{R}FAIL{N}"
            print(f"  {mark}  :{p}  {r.passed} passed, {r.failed} failed")
        print()
    if total_fail:
        print(f"{R}{B}{total_fail} check(s) failed{N} ({total_pass} passed)\n")
        sys.exit(1)
    print(f"{G}{B}all {total_pass} checks passed{N}\n")


if __name__ == "__main__":
    main()
