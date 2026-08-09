#!/usr/bin/env python3
"""Print one consolidated connect table for all three backends.

Each backend's supervisor already prints its own URLs on start; this collapses
them into a single block with the remote (Tailscale) address up front, so
`make start` ends with exactly what you type into Safari on the phone.

    ./urls.py            all backends
    ./urls.py 8701 8703  only these ports
"""

from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# name, label, port — keep in sync with each folder's SERVICE block
BACKENDS = [
    ("myrust", "Rust · axum", 8701),
    ("mypython", "Python · http.server", 8702),
    ("mytypescript", "TypeScript · node:http", 8703),
]


def _load_supervisor():
    """Reuse one backend's supervisor for tailscale/lan/health helpers."""
    for name, _, _ in BACKENDS:
        path = ROOT / name / "supervisor.py"
        if not path.exists():
            continue
        spec = importlib.util.spec_from_file_location(f"_sup_{name}", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    raise SystemExit("no supervisor.py found next to urls.py")


sup = _load_supervisor()
C = sup.C


def main(argv: list[str]) -> int:
    wanted = {int(a) for a in argv if a.isdigit()}
    rows = [b for b in BACKENDS if not wanted or b[2] in wanted]

    ts = sup.tailscale_info()
    lan = sup.lan_ip()
    remote = ts.get("dns") or ts.get("ip")

    # every column holds a real, copy-pasteable URL — no <port> placeholders
    cols = [("remote", remote), ("lan", lan), ("local", "localhost")]
    cols = [(head, host) for head, host in cols if host]

    label_w = max(len(label) for _, label, _ in rows)
    col_w = [
        max(len(head), max(len(f"http://{host}:{port}") for _, _, port in rows))
        for head, host in cols
    ]
    # two leading spaces, dot, space, label, then the columns
    total = 4 + label_w + sum(w + 2 for w in col_w)
    stacked = total > shutil.get_terminal_size((100, 24)).columns

    print()
    print(f"  {C['b']}Aperture{C['r']} {C['dim']}— open the gallery{C['r']}")
    print()

    if not stacked:
        head = " " * (4 + label_w)
        head += "  ".join(f"{C['dim']}{h:<{w}}{C['r']}" for (h, _), w in zip(cols, col_w))
        print(f"  {head}".rstrip())

    for _, label, port in rows:
        up = sup.health(port) is not None
        dot = f"{C['grn']}●{C['r']}" if up else f"{C['red']}○{C['r']}"
        state = "" if up else f"  {C['dim']}(not running){C['r']}"

        if stacked:
            print(f"  {dot} {C['b']}{label}{C['r']}{state}")
            for (head, host), w in zip(cols, col_w):
                url = f"http://{host}:{port}"
                shown = f"{C['cyn']}{C['b']}{url}{C['r']}" if head == "remote" and up else url
                print(f"      {C['dim']}{head:<6}{C['r']} {shown}")
            continue

        cells = []
        for (head, host), w in zip(cols, col_w):
            url = f"http://{host}:{port}"
            pad = " " * (w - len(url))
            if head == "remote" and up:
                cells.append(f"{C['cyn']}{C['b']}{url}{C['r']}{pad}")
            else:
                cells.append(f"{url}{pad}" if up else f"{C['dim']}{url}{C['r']}{pad}")
        print(f"  {dot} {C['dim']}{label:<{label_w}}{C['r']}  " + "  ".join(cells).rstrip() + state)

    print()
    if remote:
        src = "tailscale" if ts.get("dns") else "tailscale ip"
        print(f"  {C['dim']}remote  {src} — open on your iPhone, same tailnet{C['r']}")
        if ts.get("dns") and ts.get("ip"):
            print(f"  {C['dim']}        or by ip: http://{ts['ip']}:{rows[0][2]}{C['r']}")
    else:
        sup.warn("tailscale not detected — run `tailscale up`, then `make urls`")
    if lan:
        print(f"  {C['dim']}lan     same wifi/ethernet only, not over the tailnet{C['r']}")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
