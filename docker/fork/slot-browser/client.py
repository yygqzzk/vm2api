"""Private Docker-exec transport: raw RFB or one bounded JSON control request."""
import os
import socket
import sys
import threading
from contextlib import suppress


def main():
    vnc = sys.argv[1:] == ["vnc"]
    if not vnc and sys.argv[1:] != ["rpc"]:
        raise SystemExit(2)
    channel = socket.socket(socket.AF_UNIX)
    channel.settimeout(15)
    channel.connect("/run/browser/vnc.sock" if vnc else "/run/browser/control.sock")
    if not vnc:
        raw = sys.stdin.buffer.readline(32769)
        if len(raw) > 32768 or not raw.endswith(b"\n"):
            raise SystemExit(2)
        channel.sendall(raw)
        reply = channel.makefile("rb").readline(32769)
        if len(reply) > 32768:
            raise SystemExit(2)
        sys.stdout.buffer.write(reply)
        return
    channel.settimeout(None)

    def send():
        try:
            while data := os.read(0, 65536):
                channel.sendall(data)
        except OSError:
            pass
        finally:
            # The receiving thread may already have closed the socket.
            with suppress(OSError):
                channel.shutdown(socket.SHUT_RDWR)

    threading.Thread(target=send, daemon=True).start()
    try:
        while data := channel.recv(65536):
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    finally:
        channel.close()


if __name__ == "__main__":
    main()
