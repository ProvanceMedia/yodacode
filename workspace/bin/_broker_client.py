"""Tiny Python client for the yodacode broker socket (4-byte BE length-prefixed JSON frames).

Used by bin/slack-tools.sh and bin/gog-wrap to route credentialed calls through the
host-side broker when running de-rooted (no tokens in env, keyring unreadable).

    from _broker_client import mediated_call
    res = mediated_call("slack_api", {"method": "auth.test", "http": "GET"})
    # -> {"t": "result", "ok": True, "data": {...}}
"""
import json
import os
import socket
import struct

SOCK = os.environ.get("YODA_BROKER_SOCK", "/run/yodacode-broker.sock")


def _request(frame, timeout=140):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(SOCK)
        body = json.dumps(frame).encode("utf-8")
        s.sendall(struct.pack(">I", len(body)) + body)
        # Read one reply frame
        hdr = b""
        while len(hdr) < 4:
            chunk = s.recv(4 - len(hdr))
            if not chunk:
                raise ConnectionError("broker closed connection")
            hdr += chunk
        (length,) = struct.unpack(">I", hdr)
        buf = b""
        while len(buf) < length:
            chunk = s.recv(min(65536, length - len(buf)))
            if not chunk:
                raise ConnectionError("broker closed mid-frame")
            buf += chunk
        return json.loads(buf.decode("utf-8"))
    finally:
        s.close()


def mediated_call(tool, args, timeout=140):
    """Call a broker tool. Returns the reply dict ({"ok": bool, "data"/"error": ...})."""
    return _request({"t": "call", "tool": tool, "args": args}, timeout=timeout)


def broker_available():
    return os.path.exists(SOCK)
