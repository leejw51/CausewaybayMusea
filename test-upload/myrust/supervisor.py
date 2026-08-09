#!/usr/bin/env python3
"""Process supervisor for the Aperture upload servers.

One copy lives in each backend folder; only the SERVICE block below differs.
It builds on demand, starts the server detached in its own process group,
waits until the port actually answers, and prints the LAN + Tailscale URLs
you need to open the gallery from an iPhone.

    ./supervisor.py start | stop | restart | status | logs | urls
"""

from __future__ import annotations

import errno
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# ── service definition ───────────────────────────────────────────────
SERVICE = {
    "name": "myrust",
    "label": "Rust · axum",
    "port": 8701,
    # build command, run from ROOT; None to skip
    "build": ["cargo", "build", "--release"],
    # the actual server process
    "run": ["./target/release/aperture"],
}
# ─────────────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parent
RUN = ROOT / ".run"
PIDFILE = RUN / "server.pid"
LOGFILE = RUN / "server.log"
HOST = "0.0.0.0"

C = {
    "r": "\033[0m", "b": "\033[1m", "dim": "\033[2m",
    "grn": "\033[32m", "yel": "\033[33m", "cyn": "\033[36m",
    "red": "\033[31m", "mag": "\033[35m",
}
if not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
    C = {k: "" for k in C}


def say(msg: str = "") -> None:
    print(msg, flush=True)


def ok(msg: str) -> None:
    say(f"{C['grn']}✓{C['r']} {msg}")


def warn(msg: str) -> None:
    say(f"{C['yel']}!{C['r']} {msg}")


def die(msg: str, code: int = 1):
    say(f"{C['red']}✗{C['r']} {msg}")
    sys.exit(code)


# ── pid handling ─────────────────────────────────────────────────────

def read_pid() -> int | None:
    try:
        pid = int(PIDFILE.read_text().strip())
    except (OSError, ValueError):
        return None
    return pid if pid_alive(pid) else None


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError as e:
        return e.errno == errno.EPERM


def port_busy(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


def pids_on_port(port: int) -> list[int]:
    lsof = shutil.which("lsof")
    if not lsof:
        return []
    try:
        out = subprocess.run(
            [lsof, "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            capture_output=True, text=True, timeout=6,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return []
    return [int(x) for x in out.split() if x.strip().isdigit()]


# ── tailscale ────────────────────────────────────────────────────────

def tailscale_bin() -> str | None:
    found = shutil.which("tailscale")
    if found:
        return found
    for cand in (
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/usr/bin/tailscale",
    ):
        if Path(cand).exists():
            return cand
    return None


def tailscale_info() -> dict:
    """Return {'ip': str|None, 'dns': str|None, 'host': str|None}."""
    info = {"ip": None, "dns": None, "host": None}
    ts = tailscale_bin()
    if not ts:
        return info
    try:
        proc = subprocess.run([ts, "status", "--json"], capture_output=True, text=True, timeout=10)
        data = json.loads(proc.stdout)
        me = data.get("Self") or {}
        ips = me.get("TailscaleIPs") or []
        for ip in ips:
            if ":" not in ip:
                info["ip"] = ip
                break
        dns = (me.get("DNSName") or "").rstrip(".")
        if dns:
            info["dns"] = dns
        info["host"] = me.get("HostName")
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError, ValueError):
        pass
    if not info["ip"]:
        try:
            out = subprocess.run([ts, "ip", "-4"], capture_output=True, text=True, timeout=8).stdout
            for line in out.splitlines():
                line = line.strip()
                if line and not line.lower().startswith("warning"):
                    info["ip"] = line
                    break
        except (subprocess.SubprocessError, OSError):
            pass
    return info


def lan_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(0.5)
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return None


def print_urls(port: int) -> None:
    ts = tailscale_info()
    lan = lan_ip()
    say()
    say(f"  {C['b']}Open the gallery{C['r']}")
    say(f"    {C['dim']}local     {C['r']}http://localhost:{port}")
    if lan:
        say(f"    {C['dim']}lan       {C['r']}http://{lan}:{port}")
    if ts["dns"]:
        say(f"    {C['dim']}tailscale {C['r']}{C['cyn']}{C['b']}http://{ts['dns']}:{port}{C['r']}  {C['dim']}← use this on your iPhone{C['r']}")
    if ts["ip"]:
        label = "tailscale" if not ts["dns"] else "  ip     "
        say(f"    {C['dim']}{label} {C['r']}http://{ts['ip']}:{port}")
    if not ts["ip"] and not ts["dns"]:
        warn("tailscale not detected — run `tailscale up`, then `make urls`")
    say()


# ── health ───────────────────────────────────────────────────────────

def health(port: int, timeout: float = 1.5) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=timeout) as r:
            return json.loads(r.read().decode())
    except (urllib.error.URLError, OSError, json.JSONDecodeError, ValueError):
        return None


def wait_healthy(port: int, pid: int, seconds: float = 90.0) -> dict | None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if not pid_alive(pid):
            return None
        h = health(port, timeout=1.0)
        if h:
            return h
        time.sleep(0.25)
    return None


# ── commands ─────────────────────────────────────────────────────────

def cmd_build() -> None:
    build = SERVICE.get("build")
    if not build:
        return
    # `build` is either one command (list of str) or several (list of lists)
    steps = build if isinstance(build[0], list) else [build]
    say(f"{C['dim']}building {SERVICE['name']} …{C['r']}")
    for step in steps:
        say(f"{C['dim']}$ {' '.join(step)}{C['r']}")
        if subprocess.run(step, cwd=ROOT).returncode != 0:
            die(f"build failed: {' '.join(step)}")
    ok("build ok")


def cmd_start(skip_build: bool = False) -> None:
    RUN.mkdir(exist_ok=True)
    port = SERVICE["port"]

    existing = read_pid()
    if existing:
        warn(f"{SERVICE['name']} already running (pid {existing})")
        print_urls(port)
        return
    if port_busy(port):
        others = pids_on_port(port)
        die(f"port {port} is already in use{f' by pid(s) {others}' if others else ''} — run `make stop` first")

    if not skip_build:
        cmd_build()

    env = dict(os.environ, PORT=str(port), HOST=HOST, APERTURE_BACKEND=SERVICE["label"])
    log = open(LOGFILE, "ab", buffering=0)
    log.write(f"\n=== start {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n".encode())

    proc = subprocess.Popen(
        SERVICE["run"], cwd=ROOT, env=env,
        stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    PIDFILE.write_text(str(proc.pid))
    say(f"{C['dim']}starting {SERVICE['label']} on {HOST}:{port} (pid {proc.pid}) …{C['r']}")

    h = wait_healthy(port, proc.pid)
    if not h:
        tail = LOGFILE.read_text(errors="replace").splitlines()[-25:] if LOGFILE.exists() else []
        PIDFILE.unlink(missing_ok=True)
        if pid_alive(proc.pid):
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        say(f"{C['red']}--- last log lines ---{C['r']}")
        for line in tail:
            say("  " + line)
        die("server did not become healthy")

    ok(f"{C['b']}{h.get('backend', SERVICE['label'])}{C['r']} listening on {HOST}:{port}  {C['dim']}(pid {proc.pid}){C['r']}")
    say(f"  {C['dim']}storage {C['r']}{ROOT / 'data'}")
    say(f"  {C['dim']}log     {C['r']}{LOGFILE}")
    print_urls(port)


def cmd_stop() -> None:
    port = SERVICE["port"]
    pid = read_pid()
    stopped = False

    if pid:
        stopped = terminate(pid)
        PIDFILE.unlink(missing_ok=True)
    else:
        PIDFILE.unlink(missing_ok=True)

    # anything still squatting on the port (e.g. started outside the supervisor)
    for stray in pids_on_port(port):
        if stray != pid:
            warn(f"killing stray listener on :{port} (pid {stray})")
            terminate(stray)
            stopped = True

    if stopped:
        ok(f"{SERVICE['name']} stopped")
    else:
        say(f"{C['dim']}{SERVICE['name']} was not running{C['r']}")


def terminate(pid: int) -> bool:
    def signal_all(sig):
        try:
            os.killpg(os.getpgid(pid), sig)
        except OSError:
            try:
                os.kill(pid, sig)
            except OSError:
                return False
        return True

    if not pid_alive(pid):
        return False
    signal_all(signal.SIGTERM)
    for _ in range(60):  # up to 6s for in-flight uploads to unwind
        if not pid_alive(pid):
            return True
        time.sleep(0.1)
    warn(f"pid {pid} ignored SIGTERM — sending SIGKILL")
    signal_all(signal.SIGKILL)
    time.sleep(0.3)
    return True


def cmd_status() -> None:
    port = SERVICE["port"]
    pid = read_pid()
    h = health(port)
    if pid and h:
        say(f"{C['grn']}●{C['r']} {C['b']}{SERVICE['name']}{C['r']} running — pid {pid}, port {port}, backend {h.get('backend')}")
        say(f"  {C['dim']}items {h.get('items', '?')} · stored {h.get('storedBytes', 0)} bytes · uptime {h.get('uptime', '?')}s{C['r']}")
        print_urls(port)
    elif pid:
        warn(f"{SERVICE['name']} pid {pid} alive but /api/health is not answering on :{port}")
    elif port_busy(port):
        warn(f"port {port} is busy but no supervisor pidfile — foreign process? {pids_on_port(port)}")
    else:
        say(f"{C['dim']}○ {SERVICE['name']} stopped{C['r']}")


def cmd_logs(follow: bool) -> None:
    if not LOGFILE.exists():
        die(f"no log yet at {LOGFILE}")
    if follow:
        try:
            subprocess.run(["tail", "-f", str(LOGFILE)])
        except KeyboardInterrupt:
            pass
    else:
        subprocess.run(["tail", "-n", "80", str(LOGFILE)])


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    rest = sys.argv[2:]
    if cmd == "start":
        cmd_start(skip_build="--no-build" in rest)
    elif cmd == "stop":
        cmd_stop()
    elif cmd == "restart":
        cmd_stop()
        time.sleep(0.4)
        cmd_start(skip_build="--no-build" in rest)
    elif cmd == "status":
        cmd_status()
    elif cmd == "build":
        cmd_build()
    elif cmd == "logs":
        cmd_logs(follow="-f" in rest or "--follow" in rest)
    elif cmd == "urls":
        print_urls(SERVICE["port"])
    else:
        die(f"unknown command: {cmd}\nusage: supervisor.py start|stop|restart|status|build|logs|urls")


if __name__ == "__main__":
    main()
