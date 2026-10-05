"""Worker options, resolved before anything is armed or sent.

Before this module a bad value failed late:

* ``lock_ttl_ms`` that the broker rejects made the first PULLB raise a
  CommandError, and the worker shut down after 'ready'.
* An infinite heartbeat crashed the heartbeat thread with OverflowError.

The batch size, poll timeout and heartbeat follow the SDK clamps of
``sdk/CLAUDE.md`` rule 4 (:mod:`bunqueue.sdk_clamps`). A number is clamped,
never rejected; a non-number raises TypeError. ``lock_ttl_ms=None`` keeps
its 0.2.0 meaning: ``lockTtl: null`` on the wire, the broker's default lease.
"""

from __future__ import annotations

from typing import Any, Optional, Tuple

from .durations import MAX_DELAY_MS, require_duration
from .sdk_clamps import MAX_POLL_TIMEOUT_MS, clamp_poll_timeout, heartbeat_interval

__all__ = [
    "EMPTY_LONG_POLL_WAIT_S",
    "EMPTY_POLL_WAIT_S",
    "MAX_POLL_TIMEOUT_MS",
    "empty_pull_wait_s",
    "resolve_worker_durations",
]

Number = Any  # int or float, kept as given so whole numbers stay ints on the wire

#: Wait after a pull that returned no jobs, mirroring the main client
#: (src/client/worker/runtime/polling.ts: ``pollTimeout > 0 ? 10 : drainDelay``).
#: Without it the loop re-polled once per round trip: thousands of PULLB per
#: second at ``poll_timeout_ms=0``, about 700 at 1 ms.
EMPTY_POLL_WAIT_S = 0.05  # non-blocking pull (poll_timeout_ms=0): default drainDelay
EMPTY_LONG_POLL_WAIT_S = 0.01  # long-poll (poll_timeout_ms > 0)


def empty_pull_wait_s(poll_timeout_ms: Number) -> float:
    """Seconds to wait after an empty pull before the next one."""
    return EMPTY_LONG_POLL_WAIT_S if poll_timeout_ms > 0 else EMPTY_POLL_WAIT_S


def resolve_worker_durations(
    poll_timeout_ms: Any, lock_ttl_ms: Any, heartbeat_interval_s: Any
) -> Tuple[Number, Optional[Number], float]:
    """Return ``(poll_timeout_ms, lock_ttl_ms, heartbeat_interval_s)``.

    * ``poll_timeout_ms`` (rule 4): clamped to [0, 30000]; NaN or None means
      5000. 0 is a non-blocking pull. An empty pull is followed by
      ``empty_pull_wait_s`` (10 ms, or 50 ms at 0).
    * ``lock_ttl_ms``: a finite number >= 1, the lease TTL; ValueError
      otherwise. Values above 2**53 - 1 are clamped to it. None stays None:
      the PULLB carries ``lockTtl: null`` and the broker leases for its
      default 30000 ms, as in 0.2.0.
    * ``heartbeat_interval_s`` (rule 4): zero, negative and non-finite values
      disable heartbeats and come back as 0.0. None means 10, and a bool
      keeps its 0.2.0 meaning (False disables, True beats every second).
      Positive values are capped at the runtime wait limit.

    Raises TypeError for a non-number.
    """
    lock_ms = lock_ttl_ms
    if lock_ttl_ms is not None:
        lock = require_duration(lock_ttl_ms, "lock_ttl_ms", minimum=1)
        lock_ms = int(MAX_DELAY_MS) if lock > MAX_DELAY_MS else lock_ttl_ms
    return clamp_poll_timeout(poll_timeout_ms), lock_ms, heartbeat_interval(heartbeat_interval_s)
