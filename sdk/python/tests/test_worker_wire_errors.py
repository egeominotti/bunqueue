"""Registration, heartbeat and ACK failures never end a Worker thread.

These paths only caught ``BunqueueError``. Any other exception out of
``Connection.call`` (an ``OSError`` from a lazy reconnect, for example) ended
the loop before it started, killed the heartbeat thread, or skipped the slot
release after an ACK. Broker-free and deterministic.

Runs with pytest or standalone: ``python tests/test_worker_wire_errors.py``.
"""

from __future__ import annotations

import logging
import sys
import threading

from worker_fakes import LogCapture, ScriptedConnection, job, make_worker, run_module, wait_until


def test_initial_registration_failure_does_not_end_the_loop() -> None:
    """Before: run() raised before its try/finally, the thread died, and
    is_running() still reported True with nothing ever pulled again."""
    boom = OSError("setsockopt: invalid argument")
    conn = ScriptedConnection([job("j1")], failures={"RegisterWorker": [boom]})
    worker = make_worker(conn)
    errors: list = []
    completed: list = []
    worker.on("error", errors.append)
    worker.on("completed", lambda j, _r: completed.append(j.id))
    with LogCapture() as logs:
        worker.start()
        try:
            assert wait_until(lambda: completed == ["j1"] or not worker._run_thread.is_alive())
            assert completed == ["j1"] and worker._run_thread.is_alive()
            assert errors == [boom]
            # The failed registration is retried by the next poll iteration.
            assert len(conn.sent("RegisterWorker")) == 2
        finally:
            assert worker.close(timeout=5)
    assert any("setsockopt" in m for m in logs.at_least(logging.WARNING))


def test_heartbeat_thread_survives_an_unexpected_exception() -> None:
    boom = RuntimeError("heartbeat transport bug")
    conn = ScriptedConnection([job("j1")], failures={"Heartbeat": [boom]})
    release = threading.Event()

    def process(_job):
        # Hold the lease until the heartbeat thread has run past its failure.
        release.wait(10)
        return "ok"

    worker = make_worker(conn, process, heartbeat_interval_s=0.02)
    errors: list = []
    completed: list = []
    worker.on("error", errors.append)
    worker.on("completed", lambda j, _r: completed.append(j.id))
    worker.start()
    try:
        # Before the fix the thread died on the first Heartbeat: 1 and 0.
        assert wait_until(
            lambda: len(conn.sent("Heartbeat")) >= 3 and len(conn.sent("JobHeartbeatB")) >= 2
        )
        assert errors and errors[0] is boom
        release.set()
        assert wait_until(lambda: completed == ["j1"])
    finally:
        release.set()
        assert worker.close(timeout=5)


def test_ack_exception_releases_the_concurrency_slot() -> None:
    """Before: the exception escaped _run_job inside the executor, the slot
    was never released, and a concurrency-1 worker stopped pulling."""
    boom = RuntimeError("ack transport bug")
    conn = ScriptedConnection([job("j1"), job("j2")], failures={"ACK": [boom]})
    worker = make_worker(conn, concurrency=1)
    errors: list = []
    completed: list = []
    worker.on("error", errors.append)
    worker.on("completed", lambda j, _r: completed.append(j.id))
    worker.start()
    try:
        assert wait_until(lambda: completed == ["j2"])
        assert errors == [boom], "an ACK that did not reach the broker is an error"
        assert [a["id"] for a in conn.sent("ACK")] == ["j1", "j2"]
    finally:
        assert worker.close(timeout=5)


if __name__ == "__main__":
    total, failed = run_module(sys.modules[__name__])
    print(f"\n{total - failed}/{total} passed")
    sys.exit(1 if failed else 0)
