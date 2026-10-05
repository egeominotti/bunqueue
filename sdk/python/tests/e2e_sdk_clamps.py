"""E2E: the four SDK clamps of sdk/CLAUDE.md rule 4 (protocol sections 6.3, 9).

A number never raises for these options: it is clamped (or disables
heartbeats). Where 0.2.0 already clamped, its results are kept (a NaN batch
size gives 1, a NaN ttl 0, a bool counts as 0 or 1). None means the default
and any other non-number raises TypeError naming the option.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List

from e2e_durations import INF, NAN
from harness import Server, test

from bunqueue import Queue, Worker


def _worker(server: Server, **options: Any) -> Worker:
    return Worker("clamps", lambda job: None, port=server.port, autorun=False, **options)


def _expect_type_error(build: Any, label: str) -> None:
    try:
        built = build()
    except TypeError:
        return
    close = getattr(built, "close", None)
    if callable(close):
        close()
    raise AssertionError(f"{label} did not raise TypeError")


def _same(actual: Any, expected: Any) -> bool:
    return not isinstance(actual, bool) and actual == expected


@test
def clamps_batch_size_follows_rule_4(server: Server) -> None:
    cases = [(NAN, 1), (INF, 1000), (-INF, 1), (0, 1), (-5, 1), (2.5, 2.5),
             (5000, 1000), (1000, 1000), (7, 7), (None, 10), (True, 1), (False, 1)]
    for given, expected in cases:
        worker = _worker(server, batch_size=given)
        try:
            assert _same(worker.batch_size, expected), (given, worker.batch_size)
        finally:
            worker.close()
    for bad in ("5", [1]):
        _expect_type_error(lambda: _worker(server, batch_size=bad), f"batch_size={bad!r}")


@test
def clamps_poll_timeout_follows_rule_4(server: Server) -> None:
    cases = [(NAN, 5000), (INF, 30000), (-INF, 0), (-1, 0), (0, 0), (250, 250),
             (250.5, 250.5), (1e9, 30000), (None, 5000)]
    for given, expected in cases:
        worker = _worker(server, poll_timeout_ms=given)
        try:
            assert _same(worker.poll_timeout_ms, expected), (given, worker.poll_timeout_ms)
        finally:
            worker.close()
    for bad in ("5000", True, {}):
        _expect_type_error(lambda: _worker(server, poll_timeout_ms=bad), f"poll_timeout_ms={bad!r}")


@test
def clamps_heartbeat_follows_rule_4(server: Server) -> None:
    cases = [(0, 0.0), (-5, 0.0), (NAN, 0.0), (INF, 0.0), (-INF, 0.0), (2.5, 2.5),
             (None, 10.0), (False, 0.0), (True, 1.0)]
    for given, expected in cases:
        worker = _worker(server, heartbeat_interval_s=given)
        try:
            assert worker.heartbeat_interval_s == expected, (given, worker.heartbeat_interval_s)
        finally:
            worker.close()
    for bad in ("10", [10]):
        _expect_type_error(
            lambda: _worker(server, heartbeat_interval_s=bad), f"heartbeat_interval_s={bad!r}"
        )


@test
def clamps_wait_for_job_ttl_follows_rule_4(server: Server) -> None:
    sent: List[Dict[str, Any]] = []
    with Queue("clamps-wait", port=server.port) as queue:

        def fake_call(command: Dict[str, Any], timeout: Any = None) -> Dict[str, Any]:
            sent.append(command)
            return {"ok": True, "completed": True, "result": "done"}

        queue.connection.call = fake_call  # type: ignore[method-assign]
        cases = [(NAN, 0), (None, 30000), (INF, 600000), (-INF, 0), (-5, 0),
                 (700_000, 600000), (1500, 1500), (False, 0), (True, 1)]
        for given, expected in cases:
            sent.clear()
            assert queue.wait_for_job("job-1", given) == "done"
            timeout = sent[0]["timeout"]
            assert _same(timeout, expected) and not math.isnan(timeout), (given, timeout)
        for bad in ("100", [1]):
            sent.clear()
            _expect_type_error(lambda: queue.wait_for_job("job-1", bad), f"ttl={bad!r}")
            assert not sent, f"ttl={bad!r} reached the wire"
