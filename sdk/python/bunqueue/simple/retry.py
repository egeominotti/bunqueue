"""Advanced in-process retry with backoff strategies (mirror of retry.ts).

This retries INSIDE the processor while the job stays active (the worker's
lock heartbeats keep it owned) — different from the server-side
attempts/backoff, which re-queues the job.

Options are read as 0.2.0 read them (:func:`.validation.option`): 0 means
the default, ``int()``/``float()`` coerce the rest, and an unknown strategy
uses the fixed delay. The documented formulas have no cap. They saturate at
``MAX_DELAY_MS`` instead of overflowing: ``1000.0 * 2 ** 1024`` used to raise
OverflowError. Every wait is capped at the runtime limit, so a finite delay
is never cut short.
"""

from __future__ import annotations

import math
import random
import time
from typing import Any, Callable, Dict, TypeVar

from ..durations import MAX_DELAY_MS, wait_seconds
from .validation import STRATEGIES, option, validate_retry

R = TypeVar("R")

__all__ = ["STRATEGIES", "calculate_backoff", "execute_with_retry"]


def _saturate(delay: float) -> float:
    return MAX_DELAY_MS if delay > MAX_DELAY_MS else delay


def _doubled(base: float, attempt: int) -> float:
    """``base * 2 ** (attempt - 1)``, saturating; 0 for a zero base."""
    if base == 0:
        return 0.0
    # A float power above 1023 overflows: the product saturates long before.
    return _saturate(base * 2.0 ** min(attempt - 1, 1023))


def _fibonacci(base: float, attempt: int) -> float:
    """``base * fib(attempt)`` for 1, 2, 3, 5, 8, ...; stops once saturated."""
    if base == 0:
        return 0.0
    a, b = 1.0, 1.0
    for _ in range(attempt - 1):
        if base * b >= MAX_DELAY_MS:
            break
        a, b = b, a + b
    return _saturate(base * b)


def _custom_delay(
    custom: Callable[[int, BaseException], Any], attempt: int, error: BaseException
) -> float:
    """The custom result read with ``float()`` as in 0.2.0 (``"7"`` and
    ``True`` still work). A result that is not a finite number of ms >= 0
    used to raise from ``time.sleep``; it now fails the retry loop with an
    error whose ``__cause__`` is the processor error."""
    result = custom(attempt, error)
    name = "the delay returned by retry.custom_backoff"
    try:
        delay = float(result)
    except (TypeError, ValueError, OverflowError):
        raise TypeError(f"{name} must be a number (got {result!r})") from error
    if not 0 <= delay < math.inf:  # NaN fails too
        expected = "a finite number of milliseconds >= 0"
        raise ValueError(f"{name} must be {expected} (got {result!r})") from error
    return delay


def calculate_backoff(
    strategy: str,
    attempt: int,
    base_delay: float,
    error: BaseException,
    config: Dict[str, Any],
) -> float:
    """Delay in ms for the given attempt (1-based), same formulas as retry.ts.

    The fixed delay (and an unknown strategy) returns ``base_delay`` as
    given; the growing strategies saturate at ``MAX_DELAY_MS``.
    """
    if strategy == "exponential":
        return _doubled(base_delay, attempt)
    if strategy == "jitter":
        return _saturate(float(int(_doubled(base_delay, attempt) * (0.5 + random.random()))))
    if strategy == "fibonacci":
        return _fibonacci(base_delay, attempt)
    if strategy == "custom":
        custom = option(config, "custom_backoff", "customBackoff", None)
        if custom:
            return _custom_delay(custom, attempt, error)
    return base_delay


def execute_with_retry(fn: Callable[[], R], config: Dict[str, Any]) -> R:
    """Run ``fn`` retrying on exception, same semantics as executeWithRetry.

    ``max_attempts`` may be ``math.inf`` (retry until success or ``retry_if``
    declines). A 0 ``max_attempts`` or ``delay`` means the default (3 and
    1000 ms), as in 0.2.0.
    """
    validate_retry(config)
    attempts = option(config, "max_attempts", "maxAttempts", 3)
    max_attempts = attempts if attempts == math.inf else int(attempts)
    base_delay = float(option(config, "delay", None, 1000))
    strategy = str(option(config, "strategy", None, "exponential"))
    retry_if = option(config, "retry_if", "retryIf", None)

    attempt = 1
    while True:
        try:
            return fn()
        except BaseException as exc:  # noqa: BLE001 - retry semantics need broad catch
            if attempt >= max_attempts:
                raise
            if retry_if is not None and not retry_if(exc, attempt):
                raise
            delay_ms = calculate_backoff(strategy, attempt, base_delay, exc, config)
            time.sleep(wait_seconds(delay_ms))
            attempt += 1
