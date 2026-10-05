"""Graceful job cancellation (mirror of cancellation.ts).

Python has no AbortController; :class:`CancelSignal` exposes the same
``aborted`` surface, checked cooperatively by processors and the middleware
chain.
"""

from __future__ import annotations

import math
import threading
from typing import Any, Dict, Optional

from ..durations import number_or_bool, wait_seconds


class CancelSignal:
    """Minimal AbortSignal equivalent: ``signal.aborted`` flips once."""

    def __init__(self) -> None:
        self._event = threading.Event()

    @property
    def aborted(self) -> bool:
        return self._event.is_set()

    def abort(self) -> None:
        self._event.set()


class CancellationManager:
    def __init__(self) -> None:
        self._signals: Dict[str, CancelSignal] = {}
        self._timers: Dict[str, threading.Timer] = {}
        self._lock = threading.Lock()

    def register(self, job_id: str) -> CancelSignal:
        signal = CancelSignal()
        with self._lock:
            self._signals[job_id] = signal
        return signal

    def unregister(self, job_id: str) -> None:
        with self._lock:
            self._signals.pop(job_id, None)
            timer = self._timers.pop(job_id, None)
        if timer:
            timer.cancel()

    def cancel(self, job_id: str, grace_period_ms: Any = 0) -> None:
        """Abort after ``grace_period_ms`` when it is > 0, otherwise at once.

        As in 0.2.0, a zero, negative, NaN or False grace aborts at once and
        True waits 1 ms; a non-number raises TypeError. An infinite grace
        raises ValueError: it crashed the Timer thread and never aborted."""
        with self._lock:
            signal = self._signals.get(job_id)
        if signal is None:
            return
        grace = number_or_bool(grace_period_ms, "grace_period_ms", "a number of milliseconds")
        if grace == math.inf:
            raise ValueError(f"grace_period_ms must be finite (got {grace_period_ms!r})")
        if grace > 0:
            timer = threading.Timer(wait_seconds(grace), signal.abort)
            timer.daemon = True
            with self._lock:
                self._timers[job_id] = timer
            timer.start()
        else:
            signal.abort()

    def is_cancelled(self, job_id: str) -> bool:
        with self._lock:
            signal = self._signals.get(job_id)
        return signal.aborted if signal else False

    def get_signal(self, job_id: str) -> Optional[CancelSignal]:
        with self._lock:
            return self._signals.get(job_id)

    def destroy_all(self) -> None:
        with self._lock:
            signals = list(self._signals.values())
            timers = list(self._timers.values())
            self._signals.clear()
            self._timers.clear()
        for timer in timers:
            timer.cancel()
        for signal in signals:
            signal.abort()
