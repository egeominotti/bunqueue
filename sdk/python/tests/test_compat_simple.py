"""Simple Mode option values keep their 0.2.0 result.

0.2.0 read every option as ``config.get(key) or default``: a 0 (or any other
falsy value) meant the default, and ``int()``/``float()`` coerced the rest.
The release candidate rejected or honored such values. Only the values
0.2.0 could not handle stay rejected: a timer that re-armed itself in a hot
loop, a sleep or ``int()`` that raised inside every job or tick, an infinite
timer that crashed its thread, or a limiter that blocked every job forever.

Broker-free. Runs with pytest or standalone:
``python tests/test_compat_simple.py``.
"""

from __future__ import annotations

import sys
import time
import types
from typing import Any, Dict, List

from worker_fakes import run_module

import bunqueue.simple.retry as retry_module
from bunqueue.simple.aging import PriorityAger
from bunqueue.simple.batch import BatchAccumulator
from bunqueue.simple.circuit_breaker import WorkerCircuitBreaker
from bunqueue.simple.rate_gate import RateGate
from bunqueue.simple.retry import execute_with_retry
from bunqueue.simple.validation import validate_bunqueue_options

NAN = float("nan")
INF = float("inf")


def _retry(config: Dict[str, Any]) -> tuple:
    """(attempts, sleeps in s) of a processor that always fails."""
    sleeps: List[float] = []
    calls = {"n": 0}
    real_time = retry_module.time
    retry_module.time = types.SimpleNamespace(sleep=sleeps.append)  # type: ignore[assignment]

    def fail() -> None:
        calls["n"] += 1
        raise RuntimeError("processor failed")

    try:
        execute_with_retry(fail, config)
    except RuntimeError:
        pass
    finally:
        retry_module.time = real_time  # type: ignore[assignment]
    return calls["n"], [round(s, 4) for s in sleeps]


def test_retry_falsy_values_mean_the_default() -> None:
    assert _retry({"max_attempts": 0}) == (3, [1.0, 2.0])
    assert _retry({"maxAttempts": 0}) == (3, [1.0, 2.0])
    assert _retry({"max_attempts": 0, "maxAttempts": 2}) == (2, [1.0])
    assert _retry({"max_attempts": 3, "delay": 0}) == (3, [1.0, 2.0])
    assert _retry({"max_attempts": 3, "delay": 10, "strategy": ""}) == (3, [0.01, 0.02])
    assert _retry({"max_attempts": 3, "delay": 10, "retry_if": 0}) == (3, [0.01, 0.02])
    assert _retry({"max_attempts": 3, "delay": 10, "retry_if": False}) == (3, [0.01, 0.02])


def test_retry_values_are_coerced_as_before() -> None:
    assert _retry({"max_attempts": -1}) == (1, [])
    assert _retry({"max_attempts": True}) == (1, [])
    assert _retry({"max_attempts": 2.5}) == (2, [1.0])
    assert _retry({"max_attempts": "4"}) == (4, [1.0, 2.0, 4.0])
    assert _retry({"max_attempts": 3, "delay": "50"}) == (3, [0.05, 0.1])
    assert _retry({"max_attempts": 3, "delay": True}) == (3, [0.001, 0.002])
    fixed = {"max_attempts": 3, "delay": 10, "strategy": "linear"}  # unknown means fixed
    assert _retry(fixed) == (3, [0.01, 0.01])
    unused = {"max_attempts": 3, "delay": 10, "strategy": "fixed", "custom_backoff": 5}
    assert _retry(unused) == (3, [0.01, 0.01])
    for result, wait in (("7", 0.007), (True, 0.001)):
        backoff = lambda a, e, r=result: r  # noqa: E731
        custom = {"max_attempts": 2, "strategy": "custom", "custom_backoff": backoff}
        assert _retry(custom) == (2, [wait]), result


def test_retry_values_that_broke_stay_rejected() -> None:
    for bad in ({"delay": NAN}, {"delay": -1}, {"delay": INF}, {"max_attempts": NAN},
                {"max_attempts": "x"}, {"retry_if": "yes"},
                {"strategy": "custom", "custom_backoff": 5}):
        try:
            validate_bunqueue_options({"retry": bad})
        except (TypeError, ValueError):
            continue
        raise AssertionError(f"retry={bad!r} was accepted")


class _StubWorker:
    paused = False

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False

    def is_paused(self) -> bool:
        return self.paused


def _breaker(config: Dict[str, Any], failures: int) -> tuple:
    breaker = WorkerCircuitBreaker(config, _StubWorker())  # type: ignore[arg-type]
    for _ in range(failures):
        breaker.on_failure()
    timer = breaker._timer
    state = breaker.current_state
    breaker.destroy()
    return state, (timer.interval if timer else None)


def test_circuit_breaker_keeps_its_0_2_0_results() -> None:
    assert _breaker({"threshold": 0}, 4) == ("closed", None)  # 0 means the default 5
    assert _breaker({"threshold": 0}, 5) == ("open", 30.0)
    assert _breaker({"threshold": 1, "reset_timeout": 0}, 1) == ("open", 30.0)
    assert _breaker({"threshold": 1, "resetTimeout": 0}, 1) == ("open", 30.0)
    assert _breaker({"threshold": 2.5}, 2) == ("open", 30.0)
    assert _breaker({"threshold": "2"}, 2) == ("open", 30.0)
    assert _breaker({"threshold": -1}, 1) == ("open", 30.0)
    assert _breaker({"threshold": 1, "reset_timeout": "100"}, 1) == ("open", 0.1)
    for accepted in ({"threshold": -1}, {"threshold": "2"}, {"threshold": 2.5},
                     {"reset_timeout": -5}, {"reset_timeout": NAN}, {"reset_timeout": "100"}):
        validate_bunqueue_options({"circuit_breaker": accepted})
    for rejected in ({"threshold": NAN}, {"threshold": "x"}, {"reset_timeout": "x"}):
        try:
            validate_bunqueue_options({"circuit_breaker": rejected})
        except (TypeError, ValueError):
            continue
        raise AssertionError(f"circuit_breaker={rejected!r} was accepted")


def _batch(config: Dict[str, Any]) -> tuple:
    accumulator = BatchAccumulator({"processor": lambda jobs: [], **config})
    return accumulator._size, accumulator._timeout_ms


def test_batch_keeps_its_0_2_0_results() -> None:
    assert _batch({"size": 3, "timeout": 0}) == (3, 5000.0)  # 0 means the default
    assert _batch({"size": 3, "timeout": "100"}) == (3, 100.0)
    for given, size in ((0, 0), (-2, -2), (2.5, 2), ("3", 3), (True, 1), (False, 0)):
        assert _batch({"size": given}) == (size, 5000.0), given
    for accepted in ({"size": 0}, {"size": 2.5}, {"size": "3"}, {"size": 4, "timeout": -1},
                     {"size": 4, "timeout": NAN}, {"size": 4, "timeout": True}):
        validate_bunqueue_options({"batch": {**accepted, "processor": lambda jobs: []}})
    try:
        BatchAccumulator({"processor": lambda jobs: []})
        raise AssertionError("a batch without size was accepted")
    except KeyError:
        pass  # the 0.2.0 error for a missing size


class _Job:
    def __init__(self, job_id: str, priority: int, age_ms: float) -> None:
        self.id, self.priority = job_id, priority
        self.created_at = time.time() * 1000 - age_ms


class _StubQueue:
    def __init__(self) -> None:
        self.scans: List[int] = []
        self.changes: List[tuple] = []

    def get_waiting(self, start: int, end: int) -> List[_Job]:
        self.scans.append(end)
        return [_Job("old", 1, 120_000), _Job("new", 1, 1000)]

    def get_jobs(self, state: str, start: int, end: int) -> List[_Job]:
        return [_Job("top", 99, 120_000)]

    def change_job_priority(self, job_id: str, priority: int) -> None:
        self.changes.append((job_id, priority))


def _aging(config: Dict[str, Any]) -> tuple:
    queue = _StubQueue()
    ager = PriorityAger(config, queue)  # type: ignore[arg-type]
    ager._schedule()
    interval = ager._timer.interval if ager._timer else None
    ager.destroy()
    ager._boost_old_jobs()
    return interval, queue.scans, queue.changes


def test_priority_aging_keeps_its_0_2_0_results() -> None:
    default = (60.0, [100], [("old", 2), ("top", 100)])
    for zero in ("interval", "min_age", "minAge", "boost", "max_priority", "maxPriority",
                 "max_scan", "maxScan"):
        assert _aging({zero: 0}) == default, zero
    assert _aging({"interval": "500"})[0] == 0.5
    assert _aging({"min_age": -1})[2] == [("old", 2), ("new", 2), ("top", 100)]
    assert _aging({"min_age": NAN})[2] == []
    assert _aging({"boost": 2.5})[2] == [("old", 3), ("top", 100)]
    assert _aging({"boost": -1})[2] == [("old", 0), ("top", 98)]
    assert _aging({"max_priority": "50"})[2] == [("old", 2)]
    assert _aging({"max_scan": 2.5})[1] == [2]
    for accepted in ({"interval": 0}, {"interval": 0.5}, {"interval": "500"}, {"min_age": -1},
                     {"min_age": NAN}, {"min_age": INF}, {"boost": 0}, {"boost": -1},
                     {"max_scan": 0}, {"max_scan": -1}, {"max_scan": 2.5}, {"max_priority": 0}):
        validate_bunqueue_options({"priority_aging": accepted})
    # A NaN or negative interval re-armed at once (a hot query loop); NaN or an
    # infinite boost, priority or scan raised in every tick.
    for rejected in ({"interval": NAN}, {"interval": -1}, {"interval": INF}, {"boost": NAN},
                     {"max_priority": INF}, {"max_scan": NAN}, {"min_age": "x"}):
        try:
            validate_bunqueue_options({"priority_aging": rejected})
        except (TypeError, ValueError):
            continue
        raise AssertionError(f"priority_aging={rejected!r} was accepted")


def test_rate_limit_keeps_its_0_2_0_results() -> None:
    def gate(options: Dict[str, Any]) -> tuple:
        rate = RateGate(options)
        return rate._max, rate._duration

    assert gate({"max": 5, "duration": 0}) == (5, 1000.0)  # 0 means the default
    assert gate({"max": 2.5, "duration": "500"}) == (2, 500.0)
    assert gate({"max": "3", "duration": True}) == (3, 1.0)
    for accepted in ({"max": 5, "duration": 0}, {"max": 5, "duration": -1},
                     {"max": 5, "duration": NAN}, {"max": 2.5}, {"max": "3"}, {"max": True}):
        validate_bunqueue_options({"rate_limit": accepted})
    # max <= 0 blocked every job forever; an infinite window raised in sleep().
    for rejected in ({"max": 0}, {"max": -1}, {"max": 0.5}, {"max": NAN},
                     {"max": 5, "duration": INF}):
        try:
            validate_bunqueue_options({"limiter": rejected})
        except (TypeError, ValueError, OverflowError):
            continue
        raise AssertionError(f"rate_limit={rejected!r} was accepted")


if __name__ == "__main__":
    total, failed = run_module(sys.modules[__name__])
    print(f"\n{total - failed}/{total} passed")
    sys.exit(1 if failed else 0)
