"""Boundary handling for durations (mirror of the main client's durations.ts).

Python's timing primitives fail late on some durations:

* NaN or a negative number: ``threading.Timer`` and ``Event.wait`` fire at
  once, while ``time.sleep`` and socket timeouts raise ValueError.
* Infinity, or anything above ``threading.TIMEOUT_MAX``: they raise
  OverflowError, often inside a background thread nobody joins.

A value that 0.2.0 handled keeps its 0.2.0 result: a bool counts as 0 or 1
where 0.2.0 computed with it, a delay that 0.2.0 read with ``float()``
still accepts a numeric string, and a NaN or negative timer delay still
fires at once. Only the values that crashed a thread, never connected,
failed every command or spun a hot loop are rejected, naming the option.
Long valid waits are capped at the runtime limit, never cut short.
"""

from __future__ import annotations

import math
import threading
from typing import Any, Optional

#: Longest wait, in seconds, that threading, ``time.sleep`` and socket timeouts
#: accept (about 292 years on 64-bit CPython). Longer valid waits are capped.
MAX_WAIT_S = float(threading.TIMEOUT_MAX)

#: Saturation point of computed backoffs: 2**53 - 1 ms (about 285,000 years),
#: the main client's ``MAX_RETRY_DELAY_MS``.
MAX_DELAY_MS = float(2**53 - 1)


def _number(value: Any, name: str, expected: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be {expected} (got {value!r})")
    try:
        return float(value)
    except OverflowError:  # an int beyond the float range
        return math.inf if value > 0 else -math.inf


def number_or_bool(value: Any, name: str, expected: str) -> float:
    """``value`` as a float, where 0.2.0 computed with a bool as 0 or 1.

    Any other non-number raises TypeError naming the option.
    """
    return _number(int(value) if isinstance(value, bool) else value, name, expected)


def require_duration(
    value: Any,
    name: str,
    *,
    minimum: float = 0.0,
    unit: str = "milliseconds",
) -> float:
    """Return ``value`` as a float when it is a finite duration >= ``minimum``.

    Raises TypeError for a non-number (bool included) and ValueError for NaN,
    an infinity or a value below ``minimum``.
    """
    expected = f"a finite number of {unit} >= {minimum:g}"
    number = _number(value, name, expected)
    if math.isnan(number) or math.isinf(number) or number < minimum:
        raise ValueError(f"{name} must be {expected} (got {value!r})")
    return number


def wait_seconds(milliseconds: float) -> float:
    """A validated duration in ms as a wait in seconds the runtime accepts."""
    return min(milliseconds / 1000.0, MAX_WAIT_S)


def timer_delay_ms(value: Any, name: str) -> float:
    """A timer delay read as 0.2.0 read it: ``float(value)``, in ms.

    A numeric string or a bool is coerced as before, and ``float()`` raises
    as before for anything else. NaN and negative delays become 0: the 0.2.0
    timer fired at once. Infinity raises ValueError: it crashed the timer
    thread and stranded whatever the timer was meant to flush.
    """
    delay = float(value)
    if delay == math.inf:
        raise ValueError(f"{name} must be a finite number of milliseconds (got {value!r})")
    return delay if delay > 0 else 0.0


def heartbeat_seconds(value: Any, name: str = "heartbeat_interval_s") -> float:
    """Normalize a heartbeat interval in seconds; 0.0 means disabled.

    Protocol spec section 6.3: zero, negative and non-finite values disable
    heartbeats; they never become a zero-delay loop or a crashed thread.
    A bool keeps its 0.2.0 meaning (``False`` disables, ``True`` beats every
    second). Positive values above ``MAX_WAIT_S`` are capped at it.
    """
    if isinstance(value, bool):
        return float(value)
    number = _number(value, name, "a number of seconds")
    if math.isnan(number) or math.isinf(number) or number <= 0:
        return 0.0
    return min(number, MAX_WAIT_S)


def _timeout_seconds(value: Any, name: str, *, allow_infinity: bool) -> float:
    infinity = " or infinity" if allow_infinity else ""
    expected = f"a number of seconds > 0{infinity}"
    # 0.2.0 handed a bool to the socket or the future as 0 or 1 second.
    number = number_or_bool(value, name, expected)
    if number == math.inf and allow_infinity:
        return number
    if not 0 < number < math.inf:  # NaN fails too
        raise ValueError(f"{name} must be {expected} (got {value!r})")
    return min(number, MAX_WAIT_S)


def connect_timeout_s(value: Any) -> Optional[float]:
    """``connect_timeout`` in seconds, > 0 and capped.

    ``None`` keeps the 0.2.0 blocking connect: no client deadline, the
    operating system's own connect timeout applies. Zero (a connect that
    never completed), NaN, negative and infinite values raise ValueError.
    """
    if value is None:
        return None
    return _timeout_seconds(value, "connect_timeout", allow_infinity=False)


def command_timeout_s(value: Any, name: str = "command_timeout") -> float:
    """A command deadline in seconds; None or +inf (returned as +inf) means
    no client-side deadline.

    Zero, negative and NaN deadlines expired before any reply could arrive:
    every command failed with CommandTimeoutError and the socket was torn
    down every third command. They raise ValueError.
    """
    if value is None:
        return math.inf
    return _timeout_seconds(value, name, allow_infinity=True)
