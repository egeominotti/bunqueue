"""E2E: option values that worked in 0.2.0 still work against a real broker.

The broker-free suites (``test_compat_options.py``, ``test_compat_simple.py``)
pin each 0.2.0 result; these checks prove the same values still process
jobs end to end.
"""

from __future__ import annotations

import threading
from typing import Any, List

from harness import Server, test, unique_name, wait_until

from bunqueue import Bunqueue, Queue, Worker
from bunqueue.connection import Connection


def _process_one(server: Server, **worker_options: Any) -> None:
    name = unique_name("compat")
    done = threading.Event()
    worker = Worker(name, lambda job: done.set() or "ok", port=server.port, **worker_options)
    try:
        with Queue(name, port=server.port) as queue:
            job = queue.add("t", {"v": 1})
            assert done.wait(10), f"job not processed with {worker_options!r}"
            assert wait_until(lambda: queue.get_state(job.id) == "completed", 10)
    finally:
        assert worker.close(timeout=10)


@test
def compat_lock_ttl_none_uses_the_broker_default(server: Server) -> None:
    # 0.2.0 sent lockTtl: null; the broker leased for its 30000 ms default.
    _process_one(server, lock_ttl_ms=None, poll_timeout_ms=100)


@test
def compat_bool_heartbeat_and_coerced_ack_delay(server: Server) -> None:
    _process_one(server, heartbeat_interval_s=False, poll_timeout_ms=100)
    _process_one(server, heartbeat_interval_s=True, poll_timeout_ms=100)
    _process_one(server, ack_batch={"max_delay_ms": "5"}, poll_timeout_ms=100)
    _process_one(server, ack_batch={"max_delay_ms": -1}, poll_timeout_ms=100)


@test
def compat_connect_timeout_none_connects(server: Server) -> None:
    connection = Connection(port=server.port, connect_timeout=None)
    try:
        assert connection.call({"cmd": "Ping"}).get("ok") is True
    finally:
        connection.close()


@test
def compat_simple_mode_zero_options_mean_the_defaults(server: Server) -> None:
    """0.2.0 read ``x or default``: these configs ran; the candidate raised."""
    name = unique_name("compat-simple")
    results: List[Any] = []
    app = Bunqueue(
        name,
        port=server.port,
        poll_timeout_ms=100,
        processor=lambda job: results.append(job.data["v"]) or "ok",
        retry={"max_attempts": 0, "delay": 0, "strategy": "linear"},
        circuit_breaker={"threshold": 0, "reset_timeout": 0},
        rate_limit={"max": 5, "duration": 0},
        priority_aging={"interval": 0, "min_age": 0, "boost": 0, "max_scan": 0},
    )
    try:
        app.add("t", {"v": 7})
        assert wait_until(lambda: results == [7], 10), results
        assert app.get_circuit_state() == "closed"
    finally:
        app.close()
