"""Worker pull-loop failure policy (broker-free, deterministic).

Mirror of the main client (src/client/worker/runtime/polling.ts
``handlePullError`` + workerPull.ts ``isTransientPullError``):

* a transient failure (lost connection, command timeout, rate limit, lock
  timeouts, redacted storage errors) is retried after 0.5, 1, 2, then 5 s,
  reset by a pull the broker answered; it is emitted as ``error``;
* a permanent refusal (auth, validation) or an unexpected exception ends the
  loop and is raised from ``run()``, as in 0.2.0, unless an ``error``
  listener is attached: then it is emitted and retried on the same schedule.

Runs with pytest or standalone: ``python tests/test_worker_pull_errors.py``.
"""

from __future__ import annotations

import logging
import sys

from worker_fakes import (
    LogCapture,
    ScriptedConnection,
    ThreadCrashes,
    job,
    make_worker,
    run_blocking,
    run_module,
    wait_until,
)

from bunqueue import AuthError, CommandError, CommandTimeoutError, ConnectionClosedError


def test_transient_failures_are_retried_without_a_listener() -> None:
    """Before: a rate limit, lock timeout or redacted storage error ended the loop."""
    conn = ScriptedConnection(
        [
            CommandError("Rate limit exceeded"),
            CommandError("Internal server error"),
            ConnectionClosedError("connection lost"),
            CommandTimeoutError("no response for PULLB within timeout"),
            CommandError("Write lock acquisition timed out"),
            job("j1"),
        ]
    )
    worker = make_worker(conn)
    completed: list = []
    worker.on("completed", lambda j, _r: completed.append(j.id))
    with LogCapture() as logs:
        worker.start()
        try:
            assert wait_until(lambda: completed == ["j1"] or worker.is_closed())
            assert completed == ["j1"] and worker.is_running()
            # 0.5 s doubling to a 5 s cap: the 0.2.0 reconnect schedule.
            assert worker._stop.backoffs() == [0.5, 1.0, 2.0, 5.0, 5.0]
        finally:
            assert worker.close(timeout=5)
    assert logs.at_least(logging.WARNING) == [], "transient failures are reported quietly"
    assert sum("Rate limit exceeded" in m for m in logs.below(logging.WARNING)) == 1


def test_permanent_refusal_with_a_listener_is_emitted_and_retried() -> None:
    conn = ScriptedConnection(
        [
            CommandError("Rate limit exceeded"),
            CommandError("Write lock acquisition timed out"),
            AuthError("Invalid token"),
            job("j1"),
            CommandError("Rate limit exceeded"),
        ]
    )
    worker = make_worker(conn, lambda j: {"done": j.id})
    errors: list = []
    completed: list = []
    worker.on("error", errors.append)
    worker.on("completed", lambda j, result: completed.append((j.id, result)))
    with LogCapture() as logs:
        worker.start()
        try:
            assert wait_until(lambda: len(errors) >= 4 or worker.is_closed()), errors
            assert not worker.is_closed(), "a listened refusal must not shut the worker down"
            assert worker.is_running() and worker._run_thread.is_alive()
            assert [str(e) for e in errors] == [
                "Rate limit exceeded",
                "Write lock acquisition timed out",
                "Invalid token",
                "Rate limit exceeded",
            ]
            assert completed == [("j1", {"done": "j1"})]
            assert [a["token"] for a in conn.sent("ACK")] == ["tok-j1"]
            # The answered pull that delivered j1 resets the schedule.
            assert worker._stop.backoffs() == [0.5, 1.0, 2.0, 0.5]
        finally:
            assert worker.close(timeout=5)
    warnings = logs.at_least(logging.WARNING)
    assert len(warnings) == 1 and "Invalid token" in warnings[0], warnings


def test_permanent_refusal_without_a_listener_ends_run() -> None:
    """0.2.0 behavior: a validation or auth refusal is raised from run()."""
    refusal = CommandError("Not authenticated")
    conn = ScriptedConnection([refusal, job("never")])
    worker = make_worker(conn)
    closed: list = []
    worker.on("closed", lambda: closed.append(True))
    assert run_blocking(worker) is refusal, "run() must raise the permanent refusal"
    assert worker.is_closed() and closed == [True] and not worker.is_running()
    assert len(conn.sent("PULLB")) == 1, "the refused pull is not retried"
    assert len(conn.sent("UnregisterWorker")) == 1


def test_auth_error_without_a_listener_ends_the_background_loop() -> None:
    refusal = AuthError("Invalid token")
    conn = ScriptedConnection([refusal, job("never")])
    worker = make_worker(conn)
    with ThreadCrashes() as crashes:
        worker.start()
        ended = wait_until(worker.is_closed, 5)
        if not ended:
            worker.close(timeout=5)
        elif worker._run_thread is not None:
            worker._run_thread.join(5)  # let the excepthook run before restoring it
    assert ended, "the background loop kept running"
    assert crashes.errors == [refusal], crashes.errors
    assert not worker.is_running() and len(conn.sent("PULLB")) == 1


def test_unexpected_exception_without_a_listener_ends_run() -> None:
    boom = RuntimeError("malformed PULLB response")
    conn = ScriptedConnection([boom, job("never")])
    worker = make_worker(conn)
    assert run_blocking(worker) is boom, "run() must raise the unexpected exception"
    assert worker.is_closed() and len(conn.sent("PULLB")) == 1


def test_unexpected_exception_with_a_listener_is_reported_and_retried() -> None:
    boom = RuntimeError("malformed PULLB response")
    conn = ScriptedConnection([boom, job("j1")])
    worker = make_worker(conn)
    errors: list = []
    completed: list = []
    worker.on("error", errors.append)
    worker.on("completed", lambda j, _r: completed.append(j.id))
    with LogCapture() as logs:
        worker.start()
        try:
            assert wait_until(lambda: completed == ["j1"] or worker.is_closed())
            assert completed == ["j1"] and worker.is_running()
            assert errors == [boom]
            assert worker._stop.backoffs() == [0.5]
        finally:
            assert worker.close(timeout=5)
    records = [r for r in logs.records if r.levelno >= logging.ERROR]
    assert len(records) == 1 and records[0].exc_info is not None
    assert "malformed PULLB response" in records[0].getMessage()


def test_a_once_listener_covers_a_single_failure() -> None:
    first, second = AuthError("Invalid token"), AuthError("Invalid token")
    conn = ScriptedConnection([first, second])
    worker = make_worker(conn)
    seen: list = []
    worker.once("error", seen.append)
    assert run_blocking(worker) is second, "the second refusal has no listener left"
    assert seen == [first] and worker.is_closed()


def test_base_exception_still_ends_a_blocking_run() -> None:
    """KeyboardInterrupt/SystemExit are not pull failures: Ctrl-C stops run()."""
    conn = ScriptedConnection([KeyboardInterrupt()])
    worker = make_worker(conn)
    worker.on("error", lambda e: None)
    closed: list = []
    worker.on("closed", lambda: closed.append(True))
    try:
        worker.run()
        raise AssertionError("run() must propagate KeyboardInterrupt")
    except KeyboardInterrupt:
        pass
    assert worker.is_closed() and closed == [True]
    assert len(conn.sent("UnregisterWorker")) == 1


def test_classification_and_backoff_schedule() -> None:
    from bunqueue.worker_errors import is_transient_pull_error, pull_backoff_s

    transient = [
        ConnectionClosedError("connection lost"),
        CommandTimeoutError("no response for PULLB within timeout"),
        CommandError("Rate limit exceeded"),
        CommandError("Internal server error"),
        CommandError("Lock acquisition timed out"),
        CommandError("Read lock acquisition timed out"),
        CommandError("Write lock acquisition timed out"),
    ]
    permanent = [
        AuthError("Invalid token"),
        CommandError("Not authenticated"),
        CommandError("Invalid queue name"),
        RuntimeError("Rate limit exceeded"),  # not a broker refusal
    ]
    assert all(is_transient_pull_error(e) for e in transient)
    assert not any(is_transient_pull_error(e) for e in permanent)
    assert [pull_backoff_s(n) for n in range(1, 7)] == [0.5, 1.0, 2.0, 5.0, 5.0, 5.0]
    assert pull_backoff_s(10**6) == 5.0  # bounded: no OverflowError, no IndexError
    assert pull_backoff_s(0) == 0.5


if __name__ == "__main__":
    total, failed = run_module(sys.modules[__name__])
    print(f"\n{total - failed}/{total} passed")
    sys.exit(1 if failed else 0)
