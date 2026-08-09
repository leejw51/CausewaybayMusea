# Aperture

A photo & video gallery for testing how large uploads really behave from an
iPhone over Tailscale. The same frontend runs against three independent
backends so you can compare them on identical client code.

| folder         | backend                | port | runtime deps          |
| -------------- | ---------------------- | ---- | --------------------- |
| `myrust`       | Rust · axum            | 8701 | crates.io (cargo)     |
| `mypython`     | Python · http.server   | 8702 | **none** — stdlib     |
| `mytypescript` | TypeScript · node:http | 8703 | **none** — tsc to build |

All three bind `0.0.0.0` so they are reachable over the tailnet.

## Quick start

```sh
make start           # build + start all three, print the Tailscale URLs
make status          # what is running
make stop            # stop all three
```

Or one at a time:

```sh
cd myrust && make    # help
cd myrust && make start
```

`make start` brings up all three and ends with one table — the remote address
per backend, which is exactly what you type on the phone:

```
  Aperture — open the gallery

  ● Rust · axum             http://your-mac.tailnet-name.ts.net:8701
  ● Python · http.server    http://your-mac.tailnet-name.ts.net:8702
  ● TypeScript · node:http  http://your-mac.tailnet-name.ts.net:8703

  remote  tailscale — open these on your iPhone, same tailnet
          or by ip: http://100.x.y.z:<port>
  lan     http://192.168.x.y:<port>
  local   http://localhost:<port>
```

`●` means the backend answered its health check, `○` means it is not running.
`make urls` reprints the same table at any time.

Open the MagicDNS URL in Safari on a device signed into the same tailnet.
Nothing is exposed to the public internet — Tailscale is the only path in.

## What it does

- **1 TB per file**, photo or video, several queued at once. Files move as
  fixed **500 KB chunks** — no adaptation, no one-shot `FormData` post.
  Neither side ever holds more than one chunk in memory, so file size is a
  disk question, not a memory one. All three backends reject any single PUT
  over 8 MB.
- **Chunked and resumable.** The upload id is a hash of `name|size|mtime`, so
  reloading the page and re-picking the same file resumes from the server's
  byte offset instead of starting over.
- **Adaptive chunk size.** Starts at 4 MB and converges on roughly 2.5 s of
  wire time per chunk (512 KB … 32 MB), so progress stays smooth on a slow
  link and stops paying per-request overhead on a fast one. It halves on
  error.
- **Retry with backoff**, up to 6 attempts per chunk, re-syncing the offset
  with the server after each failure so a half-written chunk cannot desync.
- **Pause / resume / cancel** per transfer, with live rate and ETA.
- **Range streaming** on playback, so a multi-gigabyte video scrubs in Safari
  without downloading first.
- Nothing is buffered in memory on either side — chunks stream to a `.part`
  file, reads stream back out.

## The upload protocol

Identical across all three backends:

```
POST   /api/upload/init          {id,name,size,type} → {id, received, chunkSize}
GET    /api/upload/{id}/status                       → {received}
PUT    /api/upload/{id}?offset=N <raw bytes>         → {received}
POST   /api/upload/{id}/complete                     → {item}
DELETE /api/upload/{id}                              → drop the partial

GET    /api/media                                    → {items:[…]}
DELETE /api/media/{id}
GET    /media/{id}                                   → file, honours Range
GET    /api/health                                   → {backend, port, items, …}
```

The server's `.part` file length *is* the resume offset — there is no separate
bookkeeping to get out of sync. A `PUT` whose `?offset=` disagrees is rejected
with `409` and the true offset, so the client can always re-sync.

Storage per backend, under `<folder>/data`:

```
tmp/<id>.part      in-flight upload
tmp/<id>.json      declared name/size/type
blobs/<id>.<ext>   finished file
meta/<id>.json     finished metadata
```

## Tests

```sh
make test        # protocol, all three backends  (python, no deps)
make uitest      # browser, all three backends   (playwright chromium)
make chunktest   # chunk policy + resume, all three (playwright chromium)
make verify      # all three suites
```

`smoketest.py` drives the raw HTTP protocol, including the failure modes that
actually bite on a phone: a wrong offset, a chunk cut off mid-flight (raw
socket, half a chunk then FIN), resume from the partial offset, four flavours
of `Range`, concurrent range reads, path-traversal ids, and oversize files.

`chunktest.mjs` pins the chunking policy and the resume path: that a large
file goes up as many small chunks rather than one request, that no chunk
exceeds 500 KB, that offsets never regress, and that a **hard page reload
mid-transfer resumes from the server's offset** without re-sending a single
committed byte.

`uitest.mjs` drives the real UI in Chromium with the network throttled to
~40 Mbps and 60 ms latency. It verifies progress ticks through many distinct
percentages rather than jumping 0 → 100, that pausing genuinely stops the
wire, that going **offline mid-upload** produces retry/backoff and then
recovers on reconnect with the stored file intact, that video seeking issues
`206` responses, and that the phone-width layout is two-up with no sideways
scroll.

Both suites need test media first:

```sh
make fixtures            # photo, tall photo, 6s clip, ~40 MB medium video
make fixtures MB=500     # plus a ~500 MB video for a throughput run
make deps                # playwright, for uitest only
```

## Per-backend targets

Inside `myrust`, `mypython` or `mytypescript`:

| target     | what it does                                    |
| ---------- | ----------------------------------------------- |
| `help`     | default; lists targets                          |
| `start`    | build if needed, start, print the Tailscale URL |
| `stop`     | SIGTERM, then SIGKILL after 6 s                 |
| `restart`  | stop then start                                 |
| `status`   | pid, port, item count, uptime, URLs             |
| `urls`     | print local / LAN / Tailscale URLs              |
| `logs`     | last 80 lines                                   |
| `tail`     | follow the log                                  |
| `build`    | compile only                                    |
| `open`     | open the gallery in a browser                   |
| `test`     | protocol test for this backend                  |
| `uitest`   | browser test for this backend                   |
| `clean`    | drop build output, keep uploads                 |
| `distclean`| also delete `data/`                             |

`supervisor.py` in each folder owns all of it: it builds, starts the server
detached in its own process group, waits for `/api/health` to answer before
declaring success (dumping the log tail if it never does), tracks the pid,
kills strays squatting on the port, and resolves the Tailscale MagicDNS name.

## Notes

- Uploads are stored unmodified on disk; there is no auth. This is a test rig
  for a private tailnet, not something to expose publicly.
- The client hashes the resume key in plain JS rather than `crypto.subtle`,
  because `http://100.x.y.z` is not a secure context and `crypto.subtle` is
  undefined there.
- Node's default 5-minute `requestTimeout` is disabled in the TypeScript
  backend — a legitimate 4 GB chunk upload over a VPN can exceed it.
