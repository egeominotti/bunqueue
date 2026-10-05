"""Broker-free doubles for Worker error-path tests (not a pytest module).

``ScriptedConnection`` stands in for :class:`bunqueue.Connection`: every
command succeeds unless a failure is queued for it, and each ``PULLB`` takes
the next scripted step (an exception to raise, a job to deliver, or nothing
for an empty pull). Tests drive the real Worker loop deterministically,
without sockets, timing upper bounds, or a server.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
import traceback
from typing import Any, Callable, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from bunqueue import Worker  # noqa: E402


def job(job_id: str) -> Dict[str, Any]:
    return {"id": job_id, "queue": "q", "name": "t", "data": {}}


class ScriptedConnection:
    """Connection double: scripted PULLB outcomes plus per-command failures."""

    def __init__(self, pulls: List[Any], failures: Optional[Dict[str, List[BaseException]]] = None):
        self._pulls = list(pulls)
        self._failures = {cmd: list(errs) for cmd, errs in (failures or {}).items()}
        self._lock = threading.Lock()
        self.commands: List[Dict[str, Any]] = []
        self.connected = True
        self.generation = 1

    def call(self, command: Dict[str, Any], timeout: Optional[float] = None) -> Dict[str, Any]:
        with self._lock:
            self.commands.append(command)
            queued = self._failures.get(command["cmd"])
            failure = queued.pop(0) if queued else None
            step = None
            if failure is None and command["cmd"] == "PULLB" and self._pulls:
                step = self._pulls.pop(0)
        if failure is not None:
            raise failure
        if command["cmd"] != "PULLB":
            return {"ok": True}
        if isinstance(step, BaseException):
            raise step
        if step is None:
            return {"ok": True, "jobs": [], "tokens": []}
        return {"ok": True, "jobs": [step], "tokens": [f"tok-{step['id']}"]}

    def sent(self, cmd: str) -> List[Dict[str, Any]]:
        with self._lock:
            return [c for c in self.commands if c["cmd"] == cmd]

    def close(self) -> None:
        self.connected = False


class RecordingEvent(threading.Event):
    """The Worker's stop event, recording every wait the loop asks for.

    A recorded wait sleeps at most 20 ms, so a 0.5-5 s backoff schedule is
    asserted exactly without slowing the suite down."""

    def __init__(self) -> None:
        super().__init__()
        self.waits: List[Optional[float]] = []

    def wait(self, timeout: Optional[float] = None) -> bool:
        self.waits.append(timeout)
        return super().wait(0.02 if timeout is None else min(timeout, 0.02))

    def backoffs(self) -> List[float]:
        """Waits of at least 100 ms: the pull-failure backoff (empty-pull and
        paused waits are 10-50 ms)."""
        return [round(w, 3) for w in list(self.waits) if w is not None and w >= 0.1]


class LogCapture(logging.Handler):
    """Collects every record of the ``bunqueue`` logger while active."""

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: List[logging.LogRecord] = []
        self._logger = logging.getLogger("bunqueue")
        self._previous_level = self._logger.level

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def at_least(self, level: int) -> List[str]:
        return [r.getMessage() for r in self.records if r.levelno >= level]

    def below(self, level: int) -> List[str]:
        return [r.getMessage() for r in self.records if r.levelno < level]

    def __enter__(self) -> "LogCapture":
        self._logger.addHandler(self)
        self._logger.setLevel(logging.DEBUG)
        return self

    def __exit__(self, *exc: Any) -> None:
        self._logger.removeHandler(self)
        self._logger.setLevel(self._previous_level)


def make_worker(
    conn: ScriptedConnection, processor: Callable[..., Any] = lambda j: "ok", **opts: Any
):
    """A real Worker wired to ``conn`` and a RecordingEvent; not yet started."""
    opts.setdefault("concurrency", 1)
    opts.setdefault("heartbeat_interval_s", 0)
    worker = Worker("q", processor, autorun=False, **opts)
    worker.connection = conn  # never dialed: the double replaces it before start
    worker._stop = RecordingEvent()
    return worker


class ThreadCrashes:
    """Collects exceptions that end a background thread (threading.excepthook)."""

    def __init__(self) -> None:
        self.errors: List[BaseException] = []
        self._previous = threading.excepthook

    def __enter__(self) -> "ThreadCrashes":
        threading.excepthook = lambda args: self.errors.append(args.exc_value)
        return self

    def __exit__(self, *exc: Any) -> None:
        threading.excepthook = self._previous


def run_blocking(worker: Any, timeout: float = 5.0) -> Optional[BaseException]:
    """Run ``worker.run()`` in a helper thread and return what it raised.

    Fails instead of hanging when ``run()`` is still looping after
    ``timeout`` (the loop is then stopped)."""
    outcome: List[BaseException] = []

    def target() -> None:
        try:
            worker.run()
        except BaseException as exc:  # noqa: BLE001 - reported to the caller
            outcome.append(exc)

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        worker._stop.set()
        thread.join(timeout)
        raise AssertionError("run() kept looping instead of ending")
    return outcome[0] if outcome else None


def wait_until(predicate: Callable[[], bool], timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def run_module(module: Any) -> "tuple[int, int]":
    """Standalone runner (for ``run_e2e.py``): returns (total, failed)."""
    tests = [(name, fn) for name, fn in sorted(vars(module).items()) if name.startswith("test_")]
    failed = 0
    for name, fn in tests:
        started = time.monotonic()
        try:
            fn()
            print(f"PASS {module.__name__}.{name} ({(time.monotonic() - started) * 1000:.1f}ms)")
        except Exception:  # noqa: BLE001
            failed += 1
            print(f"FAIL {module.__name__}.{name}")
            traceback.print_exc()
    return len(tests), failed
