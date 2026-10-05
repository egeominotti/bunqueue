"""Worker, Connection and Queue option values keep their 0.2.0 result.

Each case is a value 0.2.0 handled without a crash, a hang, a hot loop or
an overflow, and that the release candidate rejected or changed. Values
0.2.0 could not handle stay rejected or clamped: those cases are asserted
too, so the compatibility rule never reopens a fixed failure.

Broker-free. Runs with pytest or standalone:
``python tests/test_compat_options.py``.
"""

from __future__ import annotations

import socket
import sys
from typing import Any, Callable, Dict, List

from worker_fakes import ScriptedConnection, make_worker, run_module

from bunqueue import CancellationManager, Queue, Worker
from bunqueue.connection import Connection

NAN = float("nan")
INF = float("inf")


def _worker(**options: Any) -> Worker:
    return Worker("compat", lambda job: None, autorun=False, **options)


def _raises(build: Callable[[], Any], kind: type) -> bool:
    try:
        build()
    except kind:
        return True
    return False


def test_lock_ttl_none_sends_null_for_the_broker_default() -> None:
    """0.2.0 sent ``lockTtl: null`` and the broker used its 30000 ms default."""
    conn = ScriptedConnection([None])
    worker = make_worker(conn, lock_ttl_ms=None)
    assert worker.lock_ttl_ms is None
    assert worker._poll_once() is False
    assert conn.sent("PULLB")[0]["lockTtl"] is None
    for broken in (NAN, INF, 0, 0.5, -1, "30000", True):  # leases 0.2.0 could not honor
        assert _raises(lambda: _worker(lock_ttl_ms=broken), (TypeError, ValueError)), broken


def test_heartbeat_bool_keeps_its_numeric_meaning() -> None:
    """``False`` disabled heartbeats and ``True`` beat every second."""
    disabled = _worker(heartbeat_interval_s=False)
    assert disabled.heartbeat_interval_s == 0 and not disabled.heartbeat_interval_s > 0
    every_second = _worker(heartbeat_interval_s=True)
    assert every_second.heartbeat_interval_s == 1.0
    assert not isinstance(every_second.heartbeat_interval_s, bool)


def test_batch_size_keeps_the_0_2_0_clamp() -> None:
    """``max(1, min(batch_size, 1000))``: NaN gave 1 and infinity 1000."""
    cases = [(NAN, 1), (INF, 1000), (-INF, 1), (True, 1), (False, 1), (0, 1), (5000, 1000)]
    for given, expected in cases:
        size = _worker(batch_size=given).batch_size
        assert size == expected and not isinstance(size, bool), (given, size)


def test_connect_timeout_none_means_a_blocking_connect() -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    connection = Connection(host="127.0.0.1", port=listener.getsockname()[1], connect_timeout=None)
    try:
        assert connection.connect_timeout is None
        connection.connect()  # the handshake completes against the listening socket
        assert connection.connected
    finally:
        connection.close()
        listener.close()


def test_timeouts_accept_every_positive_number_and_bools() -> None:
    assert Connection(connect_timeout=0.0005).connect_timeout == 0.0005
    assert Connection(command_timeout=0.0005).command_timeout == 0.0005
    assert Connection(connect_timeout=True).connect_timeout == 1.0
    assert Connection(command_timeout=True).command_timeout == 1.0
    assert Queue("compat", command_timeout=True).connection.command_timeout == 1.0
    # 0.2.0 never connected (0) or failed every command at once (0, NaN, < 0).
    for broken in (0, False, -1, NAN, "5"):
        assert _raises(lambda: Connection(connect_timeout=broken), (TypeError, ValueError))
        assert _raises(lambda: Connection(command_timeout=broken), (TypeError, ValueError))


def test_ack_max_delay_keeps_the_float_coercion() -> None:
    """``float(max_delay_ms)``: a negative or NaN delay flushed at once."""
    cases = [(-1, 0.0), (NAN, 0.0), ("5", 0.005), (True, 0.001), (False, 0.0), (5, 0.005)]
    for given, expected in cases:
        batcher = _worker(ack_batch={"max_delay_ms": given})._ack_batcher
        assert batcher is not None and batcher._max_delay_s == expected, (given, expected)
    assert _raises(lambda: _worker(ack_batch={"max_delay_ms": "abc"}), ValueError)
    assert _raises(lambda: _worker(ack_batch={"max_delay_ms": None}), TypeError)
    # Infinity crashed the timer thread and stranded the ACKs: still rejected.
    assert _raises(lambda: _worker(ack_batch={"max_delay_ms": INF}), ValueError)


def _cancel(grace: Any) -> tuple:
    manager = CancellationManager()
    manager.register("job")
    manager.cancel("job", grace)
    timer = manager._timers.get("job")
    try:
        return manager.is_cancelled("job"), (timer.interval if timer else None)
    finally:
        manager.destroy_all()


def test_cancel_grace_keeps_its_0_2_0_meaning() -> None:
    """``grace > 0`` armed a timer; anything else aborted at once."""
    for now in (-1, NAN, False, 0):
        assert _cancel(now) == (True, None), now
    assert _cancel(True) == (False, 0.001)
    assert _cancel(250) == (False, 0.25)
    # An infinite grace crashed the Timer thread and never aborted.
    assert _raises(lambda: _cancel(INF), ValueError)


def test_wait_for_job_nan_and_false_wait_zero() -> None:
    """``max(0, min(ttl, 600000))``: NaN and False both meant a 0 ms wait."""
    sent: List[Dict[str, Any]] = []
    queue = Queue("compat-wait")

    def fake_call(command: Dict[str, Any], timeout: Any = None) -> Dict[str, Any]:
        sent.append(command)
        return {"ok": True, "completed": True, "result": "done"}

    queue.connection.call = fake_call  # type: ignore[method-assign]
    for given in (NAN, False):
        sent.clear()
        assert queue.wait_for_job("job-1", given) == "done"
        timeout = sent[0]["timeout"]
        assert timeout == 0 and not isinstance(timeout, bool), (given, timeout)
    queue.close()


if __name__ == "__main__":
    total, failed = run_module(sys.modules[__name__])
    print(f"\n{total - failed}/{total} passed")
    sys.exit(1 if failed else 0)
