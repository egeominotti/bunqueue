"""The four clamps every official SDK applies at its surface.

These are ``sdk/CLAUDE.md`` rule 4 and ``docs/protocol.md`` sections 6.3 and
9 (the TypeScript counterpart is ``sdk/typescript/src/sdk-clamps.ts``). For
these options a number never raises:

* a heartbeat interval that is zero, negative or non-finite disables
  heartbeats (see :func:`bunqueue.durations.heartbeat_seconds`);
* the batch size, the poll timeout and the ``wait_for_job`` ttl are clamped
  to what the broker accepts.

Where 0.2.0 already clamped with ``max(low, min(value, high))`` its results
are kept: a NaN batch size gives 1 and a NaN ttl 0, and a bool counts as 0
or 1. A NaN poll timeout, which 0.2.0 sent to a broker that refused it, takes
the default. ``None`` takes the default; any other non-number raises
TypeError naming the option ("No silently dropped options").
"""

from __future__ import annotations

import math
from typing import Any, Union

from .durations import heartbeat_seconds

Number = Union[int, float]

MAX_BATCH_SIZE = 1000  # the broker rejects a PULLB count above 1000
MAX_POLL_TIMEOUT_MS = 30000  # the documented long-poll maximum (the broker accepts 60000)
MAX_WAIT_JOB_MS = 600_000  # the broker holds a WaitJob for at most 600000 ms

DEFAULT_BATCH_SIZE = 10
DEFAULT_POLL_TIMEOUT_MS = 5000
DEFAULT_WAIT_JOB_MS = 30_000
DEFAULT_HEARTBEAT_S = 10.0

__all__ = [
    "clamp_batch_size",
    "clamp_poll_timeout",
    "heartbeat_interval",
    "require_number",
    "wait_job_ttl",
]


def require_number(value: Any, name: str, expected: str, *, allow_bool: bool = False) -> Number:
    """Return ``value`` when it is an int or float (NaN included), else raise TypeError.

    With ``allow_bool`` a bool is returned as 0 or 1, as 0.2.0 computed with it.
    """
    if isinstance(value, bool):
        if allow_bool:
            return int(value)
        raise TypeError(f"{name} must be {expected} (got {value!r})")
    if not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be {expected} (got {value!r})")
    return value


def _clamp(value: Number, low: Number, high: Number) -> Number:
    return low if value < low else high if value > high else value


def clamp_batch_size(value: Any) -> Number:
    """PULLB batch size, ``max(1, min(value, 1000))`` as in 0.2.0; None means 10.

    NaN and -inf give 1 and +inf gives 1000, as they always did.
    """
    if value is None:
        return DEFAULT_BATCH_SIZE
    size = require_number(value, "batch_size", "a number", allow_bool=True)
    return max(1, min(size, MAX_BATCH_SIZE))


def clamp_poll_timeout(value: Any) -> Number:
    """PULLB long-poll timeout in ms: clamped to [0, 30000]; None or NaN means 5000."""
    if value is None:
        return DEFAULT_POLL_TIMEOUT_MS
    timeout = require_number(value, "poll_timeout_ms", "a number of milliseconds")
    if math.isnan(timeout):
        return DEFAULT_POLL_TIMEOUT_MS
    return _clamp(timeout, 0, MAX_POLL_TIMEOUT_MS)


def heartbeat_interval(value: Any) -> float:
    """Heartbeat interval in seconds; None means 10, and 0.0 means disabled."""
    if value is None:
        return DEFAULT_HEARTBEAT_S
    return heartbeat_seconds(value, "heartbeat_interval_s")


def wait_job_ttl(value: Any) -> Number:
    """The single WaitJob hold of ``wait_for_job`` in ms.

    ``max(0, min(value, 600000))`` as in 0.2.0, so NaN gives 0 and infinity
    holds for the maximum; None means 30000.
    """
    if value is None:
        return DEFAULT_WAIT_JOB_MS
    expected = "a number of milliseconds"
    ttl = require_number(value, "wait_for_job timeout_ms", expected, allow_bool=True)
    return max(0, min(ttl, MAX_WAIT_JOB_MS))
