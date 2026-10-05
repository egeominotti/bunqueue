"""Bunqueue option checks at the constructor boundary.

Every subsystem reads its options as 0.2.0 did (:func:`option`): a falsy
value (None, 0, False, "") means the default, and ``int()``/``float()``
coerce the rest, so a numeric string, a bool, a fraction or a negative
number keeps its 0.2.0 result.

This module rejects, before the Queue and Worker exist, only the values
0.2.0 could not handle:

* a priority aging interval that is NaN or negative (the Timer fired at once
  and re-armed itself: a hot loop of aging queries) or infinite (it crashed
  the Timer thread);
* a retry delay that is NaN, negative or infinite (the sleep raised inside
  the job and masked the processor's own error);
* a value ``int()``/``float()`` cannot read, which raised inside every job,
  failure or aging tick (TypeError, or ValueError for an unreadable number);
* an infinite batch timeout or rate limit window (a crashed Timer thread, a
  sleep that raised), and a rate limit ``max`` below 1 (every job blocked
  forever);
* a callback option that is set but not callable.

``math.inf`` is accepted where it has a meaning: ``retry.max_attempts``
(retry until success), ``circuit_breaker.threshold`` (never opens),
``circuit_breaker.reset_timeout`` (stays open until ``reset()``) and
``batch.size`` (flush on timeout or close only).
"""

from __future__ import annotations

import math
from typing import Any, Callable, Dict, Optional

STRATEGIES = ("fixed", "exponential", "jitter", "fibonacci", "custom")


def option(config: Dict[str, Any], snake: str, camel: Optional[str], default: Any) -> Any:
    """``config.get(snake) or config.get(camel) or default``, as 0.2.0 read it.

    A falsy value, 0 included, means the default.
    """
    value = config.get(snake)
    if not value and camel is not None:
        value = config.get(camel)
    return value or default


def validate_bunqueue_options(opts: Dict[str, Any]) -> None:
    """Raise for the first invalid feature option; return when all are valid."""
    if opts.get("retry"):
        validate_retry(opts["retry"])
    if opts.get("circuit_breaker"):
        _validate_circuit_breaker(opts["circuit_breaker"])
    if opts.get("batch"):
        _validate_batch(opts["batch"])
    if opts.get("priority_aging"):
        _validate_priority_aging(opts["priority_aging"])
    limiter = opts.get("rate_limit") or opts.get("limiter")
    if limiter:
        _validate_rate_limit(limiter)


def validate_retry(retry: Dict[str, Any]) -> None:
    attempts = option(retry, "max_attempts", "maxAttempts", 3)
    if attempts != math.inf:
        _read(int, attempts, "retry.max_attempts")
    delay = _read(float, option(retry, "delay", None, 1000), "retry.delay")
    if not 0 <= delay < math.inf:  # NaN fails too
        expected = "a finite number of milliseconds >= 0"
        raise ValueError(f"retry.delay must be {expected} (got {delay!r})")
    # An unknown strategy uses the fixed delay, as it always did.
    if str(option(retry, "strategy", None, "exponential")) == "custom":
        _callable(retry, "retry", "custom_backoff", "customBackoff")
    _callable(retry, "retry", "retry_if", "retryIf")


def _validate_circuit_breaker(breaker: Dict[str, Any]) -> None:
    threshold = option(breaker, "threshold", None, 5)
    if threshold != math.inf:
        _read(int, threshold, "circuit_breaker.threshold")
    # NaN or a negative timeout half-opens at once, as in 0.2.0.
    reset_timeout = option(breaker, "reset_timeout", "resetTimeout", 30000)
    _read(float, reset_timeout, "circuit_breaker.reset_timeout")


def _validate_batch(batch: Dict[str, Any]) -> None:
    # batch.size is read by BatchAccumulator with int(), also before the Queue
    # and Worker exist, so a missing or unreadable size fails as in 0.2.0.
    timeout = _read(float, option(batch, "timeout", None, 5000), "batch.timeout")
    if timeout == math.inf:
        raise ValueError("batch.timeout must be a finite number of milliseconds (got inf)")
    if "processor" in batch and not callable(batch["processor"]):
        raise TypeError(f"batch.processor must be a function (got {batch['processor']!r})")


def _validate_priority_aging(aging: Dict[str, Any]) -> None:
    interval = _read(float, option(aging, "interval", None, 60000), "priority_aging.interval")
    if not 0 < interval < math.inf:  # NaN fails too
        expected = "a finite number of milliseconds > 0"
        raise ValueError(f"priority_aging.interval must be {expected} (got {interval!r})")
    _read(float, option(aging, "min_age", "minAge", 60000), "priority_aging.min_age")
    _read(int, option(aging, "boost", None, 1), "priority_aging.boost")
    _read(int, option(aging, "max_priority", "maxPriority", 100), "priority_aging.max_priority")
    _read(int, option(aging, "max_scan", "maxScan", 100), "priority_aging.max_scan")


def _validate_rate_limit(limiter: Dict[str, Any]) -> None:
    # A missing max raises KeyError as in 0.2.0, but before the Worker exists.
    maximum = _read(int, limiter["max"], "rate_limit.max")
    if maximum < 1:
        raise ValueError(f"rate_limit.max must be >= 1 (got {limiter['max']!r})")
    duration = _read(float, option(limiter, "duration", None, 1000), "rate_limit.duration")
    if duration == math.inf:
        raise ValueError("rate_limit.duration must be a finite number of milliseconds (got inf)")


def _read(kind: Callable[[Any], Any], value: Any, name: str) -> Any:
    """``kind(value)`` as the subsystem computes it; a failure names the option."""
    try:
        return kind(value)
    except TypeError as exc:
        raise TypeError(f"{name} must be a number (got {value!r})") from exc
    except (ValueError, OverflowError) as exc:
        raise ValueError(f"{name} must be a finite number (got {value!r})") from exc


def _callable(config: Dict[str, Any], group: str, snake: str, camel: Optional[str]) -> None:
    value = option(config, snake, camel, None)
    if value is not None and not callable(value):
        raise TypeError(f"{group}.{snake} must be a function (got {value!r})")
