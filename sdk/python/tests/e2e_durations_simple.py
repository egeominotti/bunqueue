"""E2E: Simple Mode rejects, before the Queue and Worker exist, only the
option values 0.2.0 could not handle: a hot timer loop, a crashed Timer
thread, a sleep or ``int()`` that raised inside every job or tick, or a
limiter that blocked every job. Every other value keeps its 0.2.0 reading
(``x or default``, then ``int()``/``float()``); see test_compat_simple.py.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Dict, List

from e2e_durations import INF, NAN, expect_rejected, thread_crashes
from harness import Server, test, unique_name

from bunqueue import Bunqueue, CancellationManager
from bunqueue.simple import calculate_backoff, execute_with_retry
from bunqueue.simple.circuit_breaker import WorkerCircuitBreaker

BAD_OPTIONS: List[Dict[str, Any]] = [
    {"retry": {"delay": NAN}},
    {"retry": {"delay": -1}},
    {"retry": {"delay": INF}},
    {"retry": {"delay": "soon"}},
    {"retry": {"maxAttempts": NAN}},
    {"retry": {"max_attempts": "many"}},
    {"retry": {"strategy": "custom", "custom_backoff": 5}},
    {"retry": {"retry_if": "yes"}},
    {"circuit_breaker": {"threshold": NAN}},
    {"circuit_breaker": {"resetTimeout": "later"}},
    {"priority_aging": {"interval": NAN}},
    {"priority_aging": {"interval": -1}},
    {"priority_aging": {"interval": INF}},
    {"priority_aging": {"boost": NAN}},
    {"priority_aging": {"max_priority": INF}},
    {"priority_aging": {"max_scan": NAN}},
    {"rate_limit": {"max": 5, "duration": INF}},
    {"limiter": {"max": -1, "duration": 1000}},
    {"limiter": {"max": 0.5, "duration": 1000}},
]

BAD_BATCHES: List[Dict[str, Any]] = [
    {"size": NAN},
    {"size": "many"},
    {"size": 4, "timeout": INF},
    {"size": 4, "timeout": "soon"},
]


@test
def simple_durations_reject_invalid_options(server: Server) -> None:
    threads_before = threading.active_count()
    for options in BAD_OPTIONS:
        expect_rejected(
            lambda: Bunqueue(unique_name("v"), port=server.port, processor=lambda j: 1, **options),
            repr(options),
        )
    for batch in BAD_BATCHES:
        expect_rejected(
            lambda: Bunqueue(
                unique_name("v"), port=server.port, batch={**batch, "processor": lambda jobs: []}
            ),
            f"batch={batch!r}",
        )
    time.sleep(0.2)
    # Validation runs before the Queue and Worker exist: nothing was started.
    assert threading.active_count() <= threads_before, "a rejected Bunqueue leaked threads"


@test
def simple_durations_accept_documented_edges(server: Server) -> None:
    app = Bunqueue(
        unique_name("edges"),
        port=server.port,
        processor=lambda j: 1,
        autorun=False,
        retry={"max_attempts": INF, "delay": 0, "strategy": "fixed"},
        circuit_breaker={"threshold": INF, "reset_timeout": INF},
        priority_aging={"interval": 1000, "min_age": 0},
        rate_limit={"max": 3, "duration": 1000},
    )
    app.close(force=True)
    sized = Bunqueue(
        unique_name("edges-batch"),
        port=server.port,
        autorun=False,
        batch={"size": INF, "timeout": 50, "processor": lambda jobs: []},
    )
    sized.close(force=True)


@test
def simple_retry_zero_delay_means_the_default(_server: Server) -> None:
    calls = {"n": 0}

    def flaky() -> str:
        calls["n"] += 1
        if calls["n"] < 2:
            raise RuntimeError("transient")
        return "ok"

    started = time.monotonic()
    result = execute_with_retry(flaky, {"max_attempts": 2, "delay": 0, "strategy": "fixed"})
    elapsed = time.monotonic() - started
    assert result == "ok" and calls["n"] == 2
    # 0.2.0 read ``delay or 1000``: a 0 delay waits the 1000 ms default.
    assert elapsed >= 0.9, f"retry delay 0 slept {elapsed:.2f}s instead of the 1 s default"


@test
def simple_retry_backoff_is_overflow_safe(_server: Server) -> None:
    error = RuntimeError("x")
    for strategy in ("exponential", "jitter", "fibonacci"):
        for base in (1000.0, 0.0):
            delay = calculate_backoff(strategy, 5000, base, error, {})
            assert delay == delay and delay != INF and delay >= 0, (strategy, base, delay)
            if base == 0.0:
                assert delay == 0, (strategy, delay)


@test
def simple_retry_invalid_custom_backoff_keeps_the_cause(_server: Server) -> None:
    for bad in (NAN, -1, INF, "ten", None):  # "10" is read with float(), as in 0.2.0
        original = RuntimeError("processor failed")

        def fail() -> None:
            raise original

        config = {"max_attempts": 3, "strategy": "custom", "custom_backoff": lambda a, e: bad}
        try:
            execute_with_retry(fail, config)
        except (TypeError, ValueError) as exc:
            assert exc.__cause__ is original, f"{bad!r}: cause is {exc.__cause__!r}"
        else:
            raise AssertionError(f"custom_backoff returning {bad!r} was accepted")


@test
def simple_cancel_grace_keeps_its_0_2_0_meaning(_server: Server) -> None:
    manager = CancellationManager()
    manager.register("job-1")
    # An infinite grace crashed the Timer thread; a non-number raised as before.
    for bad in (INF, "100", None):
        expect_rejected(lambda: manager.cancel("job-1", bad), f"grace_period_ms={bad!r}")
    assert not manager.is_cancelled("job-1")
    for now in (NAN, -1, 0):  # anything not > 0 aborts at once
        manager.register("job-2")
        manager.cancel("job-2", now)
        assert manager.is_cancelled("job-2"), now
    manager.cancel("job-1", 0)
    assert manager.is_cancelled("job-1")


class _StubWorker:
    def __init__(self) -> None:
        self.paused = False

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False

    def is_paused(self) -> bool:
        return self.paused


@test
def simple_infinite_reset_timeout_stays_open(_server: Server) -> None:
    worker = _StubWorker()
    breaker = WorkerCircuitBreaker({"threshold": 1, "reset_timeout": INF}, worker)  # type: ignore[arg-type]
    with thread_crashes() as crashes:
        breaker.on_failure()
        time.sleep(0.2)
    try:
        assert not crashes, f"reset timer crashed: {crashes}"
        assert breaker.is_open() and worker.paused, "breaker left the open state"
        breaker.reset()
        assert breaker.current_state == "closed" and not worker.paused
    finally:
        breaker.destroy()
