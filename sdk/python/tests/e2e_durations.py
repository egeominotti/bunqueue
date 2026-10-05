"""E2E: duration options are validated where they enter.

A duration that reaches a timer, a sleep, a socket timeout or a backoff as
NaN, an infinity, a negative number or a value beyond the platform limit
used to fail late: an OverflowError in a background thread, an immediate
spurious timeout, a busy poll loop, or a worker that died after 'ready'.
"""

from __future__ import annotations

import contextlib
import threading
import time
from typing import Any, Callable, Dict, Iterator, List

from harness import Server, free_port, test, unique_name

from bunqueue import ConnectionClosedError, Queue, Worker
from bunqueue.connection import Connection

NAN = float("nan")
INF = float("inf")


@contextlib.contextmanager
def thread_crashes() -> Iterator[List[str]]:
    """Collect uncaught exceptions of background threads (Timer, heartbeat)."""
    crashes: List[str] = []
    previous = threading.excepthook

    def record(args: Any) -> None:
        crashes.append(f"{args.exc_type.__name__}: {args.exc_value}")

    threading.excepthook = record
    try:
        yield crashes
    finally:
        threading.excepthook = previous


def expect_rejected(build: Callable[[], Any], label: str) -> None:
    try:
        built = build()
    except (TypeError, ValueError):
        return
    close = getattr(built, "close", None)
    if callable(close):
        close()
    raise AssertionError(f"{label} was accepted")


@test
def durations_reconnect_backoff_never_overflows(_server: Server) -> None:
    # A broker down for ~85 minutes reaches ~1025 failed connects; the old
    # 0.5 * 2**(n - 1) raised OverflowError instead of ConnectionClosedError.
    port = free_port()  # nothing listens here: every connect is refused
    connection = Connection(port=port)
    try:
        for attempt in range(1, 1031):
            connection._next_attempt_at = 0.0  # skip the wait, keep the count
            try:
                connection.connect()
            except ConnectionClosedError:
                pass
            except OverflowError as exc:
                raise AssertionError(f"attempt {attempt} overflowed: {exc}") from exc
        wait_s = connection._next_attempt_at - time.monotonic()
        assert 0 < wait_s <= 5.0, f"backoff after 1030 failures is {wait_s}s"
    finally:
        connection.close()


@test
def durations_connection_rejects_invalid_timeouts(_server: Server) -> None:
    # 0.2.0 never connected (0, False) or raised from the socket on connect.
    for bad in (NAN, -1.0, 0, False, -INF, INF, "5"):
        expect_rejected(lambda: Connection(connect_timeout=bad), f"connect_timeout={bad!r}")
    # 0.2.0 failed every command at once (and raised on "5").
    for bad in (NAN, -1.0, 0, False, -INF, "5"):
        expect_rejected(lambda: Connection(command_timeout=bad), f"command_timeout={bad!r}")
        expect_rejected(lambda: Queue("q", command_timeout=bad), f"Queue command_timeout={bad!r}")
    # A huge but valid connect timeout is capped instead of overflowing; None
    # (a blocking connect) and True (1 s) keep their 0.2.0 meaning.
    Connection(connect_timeout=1e300).close()
    assert Connection(connect_timeout=None).connect_timeout is None
    assert Connection(connect_timeout=True, command_timeout=True).command_timeout == 1.0


@test
def durations_infinite_command_timeout_means_no_deadline(server: Server) -> None:
    name = unique_name("inf-timeout")
    with Queue(name, port=server.port, command_timeout=INF) as queue:
        # PULL waits server-side, so the client really waits on its future.
        response = queue.connection.call({"cmd": "PULL", "queue": name, "timeout": 200})
        assert response.get("ok") is True
        assert queue.count() == 0


@test
def durations_explicit_call_timeout_is_validated(server: Server) -> None:
    with Queue(unique_name("call-timeout"), port=server.port) as queue:
        for bad in (NAN, -1.0, 0):
            expect_rejected(lambda: queue.connection.call({"cmd": "Ping"}, timeout=bad), f"{bad!r}")
        assert queue.connection.ping()


@test
def durations_worker_rejects_invalid_options(server: Server) -> None:
    def build(**options: Any) -> Worker:
        return Worker("q", lambda job: None, port=server.port, autorun=False, **options)

    # NaN and negative poll timeouts are clamped (rule 4, e2e_sdk_clamps.py).
    for bad in ("5", True):
        expect_rejected(lambda: build(poll_timeout_ms=bad), f"poll_timeout_ms={bad!r}")
    for bad in (NAN, 0, -1, 0.5, INF, "30000", True):
        expect_rejected(lambda: build(lock_ttl_ms=bad), f"lock_ttl_ms={bad!r}")
    # max_delay_ms is read with float() as in 0.2.0: only infinity (a crashed
    # timer thread) and what float() cannot read are rejected.
    for bad in (INF, "abc", None):
        expect_rejected(
            lambda: build(ack_batch={"max_delay_ms": bad}), f"ack_batch.max_delay_ms={bad!r}"
        )
    for given, seconds in ((NAN, 0.0), (-1, 0.0), ("5", 0.005), (True, 0.001)):
        batched = build(ack_batch={"max_delay_ms": given})
        assert batched._ack_batcher._max_delay_s == seconds, (given, batched._ack_batcher)
        batched.close()
    lease = build(lock_ttl_ms=None)  # 0.2.0: lockTtl null, the broker's 30000 ms default
    assert lease.lock_ttl_ms is None
    lease.close()
    expect_rejected(lambda: build(heartbeat_interval_s="10"), "heartbeat_interval_s='10'")

    clamped = build(poll_timeout_ms=INF)
    assert clamped.poll_timeout_ms == 30000, clamped.poll_timeout_ms
    clamped.close()
    for disabled in (0, -5, NAN, INF, -INF):
        worker = build(heartbeat_interval_s=disabled)
        assert worker.heartbeat_interval_s == 0, (disabled, worker.heartbeat_interval_s)
        worker.close()
    capped = build(heartbeat_interval_s=1e300)
    assert 0 < capped.heartbeat_interval_s <= threading.TIMEOUT_MAX
    capped.close()


def count_pulls(events: List[Dict[str, Any]]) -> int:
    return sum(1 for e in events if e.get("type") == "command" and e.get("cmd") == "PULLB")


@test
def durations_zero_poll_timeout_does_not_spin(server: Server) -> None:
    events: List[Dict[str, Any]] = []
    worker = Worker(
        unique_name("zero-poll"),
        lambda job: None,
        port=server.port,
        poll_timeout_ms=0,
        on_telemetry=events.append,
    )
    try:
        worker.wait_until_ready()
        time.sleep(1.0)
        pulls = count_pulls(list(events))
    finally:
        worker.close(timeout=10)
    # Without an idle wait an empty non-blocking PULLB loop re-polls once per
    # round trip (thousands per second); the 50 ms idle wait allows ~20.
    assert pulls < 100, f"{pulls} PULLB in 1s with poll_timeout_ms=0"


@test
def durations_short_long_poll_waits_after_empty_pull(server: Server) -> None:
    events: List[Dict[str, Any]] = []
    worker = Worker(
        unique_name("short-poll"),
        lambda job: None,
        port=server.port,
        poll_timeout_ms=1,
        on_telemetry=events.append,
    )
    try:
        worker.wait_until_ready()
        time.sleep(1.0)
        pulls = count_pulls(list(events))
    finally:
        worker.close(timeout=10)
    # The main client waits 10 ms after an empty long-poll (polling.ts:
    # `pollTimeout > 0 ? 10 : drainDelay`): a 1 ms poll allows ~90 PULLB/s,
    # not one per round trip (hundreds per second).
    assert pulls < 150, f"{pulls} PULLB in 1s with poll_timeout_ms=1"


@test
def durations_zero_poll_timeout_still_processes(server: Server) -> None:
    name = unique_name("zero-poll-work")
    done = threading.Event()
    worker = Worker(name, lambda job: done.set(), port=server.port, poll_timeout_ms=0)
    try:
        with Queue(name, port=server.port) as queue:
            queue.add("t", {"v": 1})
            assert done.wait(10), "job not processed with poll_timeout_ms=0"
    finally:
        worker.close(timeout=10)


@test
def durations_infinite_heartbeat_never_crashes_a_thread(server: Server) -> None:
    with thread_crashes() as crashes:
        for interval in (INF, 1e300):
            worker = Worker(
                unique_name("hb"), lambda job: None, port=server.port,
                poll_timeout_ms=100, heartbeat_interval_s=interval,
            )
            worker.wait_until_ready()
            time.sleep(0.3)
            worker.close(timeout=10)
    assert not crashes, f"background thread crashed: {crashes}"


@test
def durations_ack_batch_delay_never_crashes_a_thread(server: Server) -> None:
    name = unique_name("ack-delay")
    done = threading.Event()
    with thread_crashes() as crashes:
        # A long but valid delay: the batch flushes on close, never by a crashed timer.
        worker = Worker(
            name, lambda job: done.set(), port=server.port, poll_timeout_ms=100,
            ack_batch={"max_size": 50, "max_delay_ms": 1e300},
        )
        try:
            with Queue(name, port=server.port) as queue:
                queue.add("t", {})
                assert done.wait(10)
                time.sleep(0.2)  # the delay timer is armed by now
        finally:
            assert worker.close(timeout=10)
    assert not crashes, f"background thread crashed: {crashes}"
    with Queue(name, port=server.port) as queue:
        counts = queue.get_job_counts()
        assert counts.get("completed", 0) == 1, counts
