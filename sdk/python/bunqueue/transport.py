"""Low-level socket and frame helpers for :mod:`bunqueue.connection`."""

from __future__ import annotations

import socket
import struct
from typing import Any, Dict

import msgpack

from .errors import SerializationError
from .wire import MAX_FRAME_SIZE, _compact, _js_safe


def encode_command(command: Dict[str, Any], req_id: str) -> bytes:
    """Serialize and frame a command, enforcing the body cap before framing."""
    try:
        normalized = _js_safe({**_compact(command), "reqId": req_id})
        payload = msgpack.packb(normalized, use_bin_type=True)
    except SerializationError:
        raise
    except Exception as exc:
        raise SerializationError(
            f"cannot msgpack-serialize {command.get('cmd')} payload: {exc}"
        ) from exc
    if len(payload) > MAX_FRAME_SIZE:
        raise SerializationError(
            f"frame size {len(payload)} exceeds maximum {MAX_FRAME_SIZE}"
        )
    return struct.pack(">I", len(payload)) + payload


def enable_keepalive(raw: socket.socket) -> None:
    """Enable portable TCP keepalive probes without making support mandatory."""
    try:
        raw.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    except OSError:
        return
    for name, value in (
        ("TCP_KEEPIDLE", 15),
        ("TCP_KEEPINTVL", 5),
        ("TCP_KEEPCNT", 3),
        ("TCP_KEEPALIVE", 15),
    ):
        code = getattr(socket, name, None)
        if code is not None:
            try:
                raw.setsockopt(socket.IPPROTO_TCP, code, value)
            except OSError:
                pass


def shutdown_socket(sock: socket.socket) -> None:
    """Send FIN and wake the reader thread parked in ``recv()`` on ``sock``.

    On Linux, ``close()`` on a socket that another thread is reading neither
    wakes that thread nor sends FIN, so the broker keeps the connection until
    the process exits and the jobs it leased until their locks expire.
    ``shutdown()`` does both.
    It raises ``OSError`` when the socket is already disconnected, e.g. when
    the reader itself tears down after the peer closed.
    """
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass


def close_socket(sock: socket.socket) -> None:
    """Close ``sock`` from its reader thread, once the read loop has ended.

    Closing it earlier frees the descriptor number while the reader can still
    use it: handling the EOF, OpenSSL writes a TLS alert through the raw
    descriptor, which by then may belong to another socket or file.
    """
    try:
        sock.close()
    except OSError:
        pass
