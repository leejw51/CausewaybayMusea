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

    width = max(len(label) for _, label, _ in rows)
    print()
    print(f"  {C['b']}Aperture{C['r']} {C['dim']}— open the gallery{C['r']}")
    print()

    for name, label, port in rows:
        up = sup.health(port) is not None
        dot = f"{C['grn']}●{C['r']}" if up else f"{C['red']}○{C['r']}"
        state = "" if up else f"  {C['dim']}(not running){C['r']}"
        host = remote or "localhost"
        url = f"http://{host}:{port}"
        shown = f"{C['cyn']}{C['b']}{url}{C['r']}" if up and remote else url
        print(f"  {dot} {C['dim']}{label:<{width}}{C['r']}  {shown}{state}")

    print()
    if remote:
        src = "tailscale" if ts.get("dns") else "tailscale ip"
        print(f"  {C['dim']}remote  {src} — open these on your iPhone, same tailnet{C['r']}")
        if ts.get("dns") and ts.get("ip"):
            print(f"  {C['dim']}        or by ip: http://{ts['ip']}:<port>{C['r']}")
    else:
        sup.warn("tailscale not detected — run `tailscale up`, then `make urls`")
    if lan:
        print(f"  {C['dim']}lan     http://{lan}:<port>{C['r']}")
    print(f"  {C['dim']}local   http://localhost:<port>{C['r']}")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
