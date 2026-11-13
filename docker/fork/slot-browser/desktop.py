"""One headed Chromium and one private VNC display. Never log URLs or input."""
import hmac
import hashlib
import http.server
import json
import os
import secrets
import shutil
import signal
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import cast
from urllib.parse import parse_qs, urlsplit

SOCKET = "/run/browser/control.sock"
VNC_SOCKET = "/run/browser/vnc.sock"
MAX_MESSAGE = 32768
LEASE_SECONDS = 45
IDLE_SECONDS = 300
IDENTITY_FILE = "browser-identity.json"
IDENTITY_MARKER = "browser-identity.sha256"


def identity_seed(root=Path("/profile")):
    file, marker = root / IDENTITY_FILE, root / IDENTITY_MARKER
    try:
        if file.is_symlink() or marker.is_symlink():
            raise ValueError("identity must be a regular file")
        if file.exists():
            data = json.loads(file.read_text())
            seed = data["seed"]
            if (data["version"] != 1 or not isinstance(seed, str) or not seed.isascii()
                    or not seed.isdecimal() or not 0 < int(seed) < 2**63):
                raise ValueError("invalid browser identity")
        else:
            if marker.exists():
                raise ValueError("saved identity is missing")
            seed = str(secrets.randbits(63) or 1)
        digest = hashlib.sha256(seed.encode()).hexdigest()
        if marker.exists() and not hmac.compare_digest(marker.read_text().strip(), digest):
            raise ValueError("saved identity does not match")
        if not file.exists():
            write_profile_file(file, json.dumps({"version": 1, "seed": seed}))
        if not marker.exists():
            write_profile_file(marker, digest)
        return seed
    except (ValueError, KeyError, TypeError, OSError) as error:
        raise RuntimeError("browser_identity_unreadable; preserve identity before repair") from error


def write_profile_file(file, value):
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=file.parent, prefix=".browser-identity-", delete=False) as temp:
            name = Path(temp.name)
            temp.write(value)
            temp.flush()
            os.fsync(temp.fileno())
        name.replace(file)
        directory = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if name is not None:
            name.unlink(missing_ok=True)


def reset_profile(root=Path("/profile")):
    for entry in root.iterdir():
        if entry.name in (IDENTITY_FILE, IDENTITY_MARKER):
            continue
        if entry.is_symlink() or not entry.is_dir():
            entry.unlink()
        else:
            shutil.rmtree(entry)


def browser_args(seed):
    return ["/usr/bin/chromium", "--user-data-dir=/profile/chromium", "--no-first-run",
            "--no-default-browser-check", "--disable-quic",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            f"--lang={os.environ['BROWSER_LANGUAGE']}", "--window-size=1280,800",
            f"--fingerprint={seed}", "--fingerprint-platform=linux",
            "--fingerprint-hardware-concurrency=8", "--fingerprint-device-memory=8",
            "--fingerprint-pixel-noise=seeded", "--fingerprint-audio-render=isolated",
            f"--fingerprint-timezone={os.environ['TZ']}",
            f"--fingerprint-locale={os.environ['BROWSER_LANGUAGE']}",
            "--fingerprint-screen-width=1280", "--fingerprint-screen-height=800",
            "--fingerprint-taskbar-height=0"]


class Desktop:
    def __init__(self, seed):
        self.seed = seed
        self.lock = threading.Lock()
        self.lease_at = time.monotonic()
        self.view_at = self.lease_at
        self.grant = None
        self.callback = None
        self.children = []
        self.ready = False

    def command(self, request):
        with self.lock:
            op = request.get("op")
            if op == "heartbeat":
                self.lease_at = time.monotonic()
                if request.get("viewing") is True:
                    self.view_at = self.lease_at
            elif op == "open":
                url = str(request.get("url", ""))
                parsed = urlsplit(url)
                if len(url) > 16384 or parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
                    raise ValueError("invalid URL")
                grant = request.get("grant")
                if grant is not None:
                    if not isinstance(grant, dict) or not isinstance(grant.get("state"), str) or not 16 <= len(grant["state"]) <= 256:
                        raise ValueError("invalid grant")
                    self.grant = {"state": grant["state"], "session_id": str(grant["session_id"]),
                                  "expires": time.monotonic() + 600}
                    self.callback = None
                subprocess.Popen([*browser_args(self.seed), "--new-tab", url], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
                self.view_at = time.monotonic()
            elif op == "callback":
                if (self.grant and time.monotonic() < self.grant["expires"]
                        and request.get("session_id") == self.grant["session_id"]):
                    return {"ok": True, "callback_url": self.callback}
                return {"ok": True, "callback_url": None}
            elif op != "status":
                raise ValueError("invalid operation")
            return {"ok": True, "ready": self.ready, "identity": hashlib.sha256(self.seed.encode()).hexdigest()[:16],
                    "timezone": os.environ["TZ"],
                    "language": os.environ["BROWSER_LANGUAGE"], "screen": "1280x800"}

    def accept_callback(self, host, path):
        if host not in ("localhost:1455", "127.0.0.1:1455") or len(path) > 16384:
            return False
        parsed = urlsplit(path)
        params = parse_qs(parsed.query)
        if parsed.path != "/auth/callback" or len(params.get("code", [])) != 1 or len(params.get("state", [])) != 1:
            return False
        with self.lock:
            if not self.grant or time.monotonic() >= self.grant["expires"] or self.callback:
                return False
            if not hmac.compare_digest(params["state"][0].encode(), self.grant["state"].encode()):
                return False
            self.callback = "http://localhost:1455" + path
            return True


class Control(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(10)
        try:
            raw = self.rfile.readline(MAX_MESSAGE + 1)
            if len(raw) > MAX_MESSAGE:
                raise ValueError("message too large")
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise ValueError("invalid request")
            result = cast(ControlServer, self.server).desktop.command(request)
        except (ValueError, KeyError, OSError):
            result = {"ok": False, "error": "browser_command_failed"}
        self.wfile.write(json.dumps(result).encode() + b"\n")


class Callback(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ok = cast(CallbackServer, self.server).desktop.accept_callback(self.headers.get("Host", ""), self.path)
        body = b"Authorization received. Return to the vm2api panel." if ok else b"Invalid or expired authorization."
        self.send_response(200 if ok else 400)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


class ControlServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    desktop: Desktop


class CallbackServer(http.server.ThreadingHTTPServer):
    desktop: Desktop


def preferences(root=Path("/profile/chromium/Default")):
    root.mkdir(parents=True, exist_ok=True)
    file = root / "Preferences"
    try:
        data = json.loads(file.read_text()) if file.exists() else {}
    except (ValueError, OSError) as error:
        raise RuntimeError("browser_profile_unreadable; preserve the profile before repair") from error
    data.setdefault("intl", {})["accept_languages"] = os.environ["BROWSER_LANGUAGES"]
    data.setdefault("session", {})["restore_on_startup"] = 1
    temp = root / "Preferences.new"
    temp.write_text(json.dumps(data))
    temp.replace(file)


def main():
    os.umask(0o077)
    seed = identity_seed()
    preferences()
    desktop = Desktop(seed)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_args: stop.set())
    signal.signal(signal.SIGINT, lambda *_args: stop.set())
    control = ControlServer(SOCKET, Control)
    control.desktop = desktop
    callback = CallbackServer(("127.0.0.1", 1455), Callback)
    callback.desktop = desktop
    for server in (control, callback):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    browser = None
    try:
        display = subprocess.Popen(["Xtigervnc", ":99", "-geometry", "1280x800", "-depth", "24",
                                    "-SecurityTypes", "None", "-rfbport", "-1", "-rfbunixpath", VNC_SOCKET,
                                    "-rfbunixmode", "0600", "-nolisten", "tcp", "-ac"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        desktop.children.append(display)
        deadline = time.monotonic() + 15
        while not Path(VNC_SOCKET).exists():
            if display.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("display_start_failed")
            time.sleep(0.1)
        desktop.children.append(subprocess.Popen(["openbox"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        browser = subprocess.Popen([*browser_args(desktop.seed), "--restore-last-session"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        desktop.children.append(browser)
        # A failed Chromium sandbox normally exits during startup. Never retry
        # with --no-sandbox, or expose a debugging port to work around it.
        started = time.monotonic()
        while not stop.wait(0.5):
            now = time.monotonic()
            if browser.poll() == 0:
                break  # The operator closed the last browser window normally.
            if any(child.poll() is not None for child in desktop.children):
                raise RuntimeError("desktop_process_exited (check Chromium sandbox support)")
            desktop.ready = now - started >= 3
            if now - desktop.lease_at > LEASE_SECONDS or now - desktop.view_at > IDLE_SECONDS:
                break
    finally:
        desktop.ready = False
        if browser is not None and browser.poll() is None:
            # Closing X first loses Chromium's pending Cookie writes. Request a
            # normal window close and keep the display alive until Chrome exits.
            windows = subprocess.run(["wmctrl", "-lx"], capture_output=True, text=True, timeout=3)
            for line in windows.stdout.splitlines():
                fields = line.split(None, 4)
                if len(fields) >= 3 and "chromium" in fields[2].lower():
                    subprocess.run(["wmctrl", "-i", "-c", fields[0]],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
            try:
                browser.wait(timeout=8)
            except subprocess.TimeoutExpired:
                browser.terminate()
        for child in reversed(desktop.children):
            if child.poll() is None:
                child.terminate()
        for child in desktop.children:
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
        control.server_close()
        callback.server_close()


if __name__ == "__main__":
    if sys.argv[1:] == ["reset-profile"]:
        reset_profile()
    elif sys.argv[1:]:
        raise SystemExit(2)
    else:
        main()
