"""E2E: how the Worker loop treats a broker refusal of PULLB.

Each check runs on a dedicated server (own env), like the auth suite:

* the broker's protocol rate limit (``Rate limit exceeded``) is transient: it
  is retried with backoff, with or without an ``error`` listener;
* an auth refusal is permanent: with an ``error`` listener it is reported on
  every attempt and retried, so fixing the token recovers the same Worker;
  without one, ``run()`` raises it and the Worker closes, as in 0.2.0.
"""

from __future__ import annotations

import logging
import time
import traceback
from typing import Callable, List, Tuple

from harness import Server, unique_name, wait_until
from worker_fakes import LogCapture, run_blocking

from bunqueue import AuthError, CommandError, Queue, Worker


def _rate_limited_pull_backs_off() -> None:
    # Per-connection quota of 3 per minute: RegisterWorker + 2 PULLB, then
    # every pull is refused for the rest of the test.
    server = Server(
        extra_env={"RATE_LIMIT_MAX_REQUESTS": "3", "RATE_LIMIT_WINDOW_MS": "60000"}
    ).start()
    try:
        worker = Worker(
            unique_name("ratelimited"),
            lambda j: "ok",
            port=server.port,
            poll_timeout_ms=0,
            heartbeat_interval_s=0,
            concurrency=1,
            autorun=False,
        )
        errors: list = []
        worker.on("error", errors.append)
        worker.start()
        try:
            assert wait_until(lambda: len(errors) >= 3 or worker.is_closed(), 10), errors
            assert not worker.is_closed(), "a rate-limit refusal shut the worker down"
            assert worker.is_running()
            refusals = [e for e in errors if isinstance(e, CommandError)]
            assert len(refusals) >= 3, errors
            assert all(str(e) == "Rate limit exceeded" for e in refusals), errors
        finally:
            worker.close(timeout=10)
    finally:
        server.stop()


def _rate_limit_without_listener_keeps_running() -> None:
    server = Server(
        extra_env={"RATE_LIMIT_MAX_REQUESTS": "3", "RATE_LIMIT_WINDOW_MS": "60000"}
    ).start()
    try:
        worker = Worker(
            unique_name("ratelimited-quiet"),
            lambda j: "ok",
            port=server.port,
            poll_timeout_ms=0,
            heartbeat_interval_s=0,
            autorun=False,
        )
        with LogCapture() as logs:
            worker.start()
            try:
                def refused() -> int:
                    return sum("Rate limit exceeded" in m for m in logs.below(logging.WARNING))

                assert wait_until(lambda: refused() >= 2 or worker.is_closed(), 10), refused()
                assert not worker.is_closed() and worker.is_running()
            finally:
                worker.close(timeout=10)
    finally:
        server.stop()


def _auth_refusal_without_listener_ends_run() -> None:
    server = Server(extra_env={"AUTH_TOKENS": "secret-token"}).start()
    try:
        worker = Worker(
            unique_name("authfail"),
            lambda j: "ok",
            port=server.port,
            token="wrong-token",
            poll_timeout_ms=300,
            heartbeat_interval_s=0,
            autorun=False,
        )
        raised = run_blocking(worker, timeout=15)
        assert isinstance(raised, AuthError), f"run() raised {raised!r}"
        assert worker.is_closed() and not worker.is_running()
    finally:
        server.stop()


def _auth_refusal_recovers_after_token_fix() -> None:
    server = Server(extra_env={"AUTH_TOKENS": "secret-token"}).start()
    try:
        with Queue(unique_name("authfix"), port=server.port, token="secret-token") as queue:
            pushed = queue.add("t", {"x": 1})
            worker = Worker(
                queue.name,
                lambda j: {"seen": j.id},
                port=server.port,
                token="wrong-token",
                poll_timeout_ms=300,
                heartbeat_interval_s=0,
                autorun=False,
            )
            errors: list = []
            completed: list = []
            worker.on("error", errors.append)
            worker.on("completed", lambda j, _r: completed.append(j.id))
            worker.start()
            try:
                assert wait_until(lambda: len(errors) >= 3 or worker.is_closed(), 10), errors
                assert not worker.is_closed(), "an auth refusal shut the worker down"
                assert all(isinstance(e, AuthError) for e in errors), errors
                assert completed == []
                worker.connection.token = "secret-token"  # the operator fixes the config
                assert wait_until(lambda: completed == [pushed.id], 15), (completed, errors[-3:])
                assert worker.is_running()
                assert wait_until(lambda: queue.get_state(pushed.id) == "completed", 5)
            finally:
                worker.close(timeout=10)
    finally:
        server.stop()


CHECKS: List[Tuple[str, Callable[[], None]]] = [
    ("rate_limited_pull_backs_off", _rate_limited_pull_backs_off),
    ("rate_limit_without_listener_keeps_running", _rate_limit_without_listener_keeps_running),
    ("auth_refusal_without_listener_ends_run", _auth_refusal_without_listener_ends_run),
    ("auth_refusal_recovers_after_token_fix", _auth_refusal_recovers_after_token_fix),
]


def run_refusal_tests() -> int:
    """Runs every check on its own server; returns the failure count."""
    failed = 0
    for name, check in CHECKS:
        started = time.monotonic()
        try:
            check()
            print(f"PASS e2e_worker_refusals.{name} ({(time.monotonic() - started) * 1000:.1f}ms)")
        except Exception:  # noqa: BLE001
            failed += 1
            print(f"FAIL e2e_worker_refusals.{name}")
            traceback.print_exc()
    return failed
