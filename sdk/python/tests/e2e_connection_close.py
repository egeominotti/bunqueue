"""E2E: closing a client ends its TCP connection on the broker side.

The reader thread stays parked in ``recv()`` for the whole life of a
connection. On Linux, ``close()`` on a socket that another thread is blocked
reading neither wakes that thread nor sends FIN, so the broker keeps the
connection until the process exits and every job it leased until the job's
lock expires (``lockTtl``, 30 s by default). macOS closes it either way, so
this test fails before the fix on Linux only.
"""

from __future__ import annotations

import threading
import time

from harness import Server, test, unique_name, wait_until

from bunqueue import Connection, Queue


@test
def close_releases_the_unacked_lease_on_the_broker(server: Server) -> None:
    name = unique_name("close-release")
    with Queue(name, port=server.port) as queue:
        job_id = queue.add("lease", {"value": 1}).id
        response = queue.connection.call(
            {"cmd": "PULL", "queue": name, "owner": "close-probe", "timeout": 1000}
        )
        assert response["job"]["id"] == job_id
        # Let the reader thread park in recv() again before the close.
        time.sleep(0.2)
        sock = queue.connection._sock

    # Only the reader thread closes the socket, once teardown has woken it.
    assert wait_until(lambda: sock.fileno() == -1, timeout=2), "socket never closed"

    with Queue(name, port=server.port) as observer:
        # The broker releases a disconnected client's leases at once; with the
        # connection still open the job would wait for its lock to expire.
        released = wait_until(lambda: observer.get_state(job_id) == "waiting", timeout=5)
        assert released, f"job is still {observer.get_state(job_id)!r} after close()"


@test
def connect_closes_the_socket_when_the_reader_cannot_start(server: Server) -> None:
    # Teardown leaves closing to the reader thread, so a socket whose reader
    # never started must be closed by connect() itself.
    started = []

    def failing_start(thread: threading.Thread) -> None:
        started.append(thread._args[0])  # type: ignore[attr-defined]
        raise RuntimeError("can't start new thread")

    connection = Connection(port=server.port)
    original_start = threading.Thread.start
    threading.Thread.start = failing_start  # type: ignore[method-assign]
    try:
        try:
            connection.connect()
            raise AssertionError("connect() succeeded without a reader thread")
        except RuntimeError:
            pass
    finally:
        threading.Thread.start = original_start  # type: ignore[method-assign]
        connection.close()

    assert len(started) == 1
    assert started[0].fileno() == -1, "the reader-less socket was left open"
    assert connection._sock is None
