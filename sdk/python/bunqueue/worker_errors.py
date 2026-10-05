"""Worker failure policy: the pull loop and the wire-failure reports.

A failed pull is classified as in the main client (``isTransientPullError``
in ``src/client/worker/workerPull.ts``, ``handlePullError`` in
``src/client/worker/runtime/polling.ts``):

* transient: a lost connection, a command timeout, the broker's rate limit,
  a lock wait that outlasted LOCK_TIMEOUT_MS, or a storage failure redacted
  to ``Internal server error``. These pass with time. The loop emits
  ``error`` and retries after 0.5, 1, 2, then 5 s (the 0.2.0 reconnect
  schedule; a pull the broker answers resets it). The ``bunqueue`` logger
  reports them at debug level.
* permanent: any other ``BunqueueError`` (auth, validation), or any other
  exception (an SDK or protocol defect). With no ``error`` listener the loop
  ends and ``run()`` raises it, as in 0.2.0; in the main client the same
  unhandled ``error`` emit ends the process. With a listener the failure is
  emitted and retried on the same schedule, so a fixed token or broker
  setting recovers the Worker without a restart. The logger reports a
  refusal as a warning and an unexpected exception as an error with its
  traceback.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from .errors import BunqueueError, CommandError, CommandTimeoutError, ConnectionClosedError

logger = logging.getLogger("bunqueue")

#: Broker refusals that pass with time, verbatim from the broker
#: (``src/client/job-wait/types.ts``, ``src/shared/lockError.ts``,
#: ``src/infrastructure/server/errors.ts``).
TRANSIENT_REFUSALS = frozenset(
    {
        "Rate limit exceeded",
        "Internal server error",
        "Lock acquisition timed out",
        "Read lock acquisition timed out",
        "Write lock acquisition timed out",
    }
)

#: The 0.2.0 retry schedule after consecutive failed pulls, in seconds.
RECONNECT_BACKOFF_S = (0.5, 1.0, 2.0, 5.0)


def is_transient_pull_error(exc: BaseException) -> bool:
    """True for a pull failure that passes with time (retried quietly)."""
    if isinstance(exc, (ConnectionClosedError, CommandTimeoutError)):
        return True
    return isinstance(exc, CommandError) and str(exc) in TRANSIENT_REFUSALS


def pull_backoff_s(consecutive_failures: int) -> float:
    """Seconds before the next pull after ``consecutive_failures`` failures."""
    index = min(max(consecutive_failures - 1, 0), len(RECONNECT_BACKOFF_S) - 1)
    return RECONNECT_BACKOFF_S[index]


def report_pull_error(worker: Any, exc: Exception, consecutive_failures: int) -> Optional[float]:
    """Report one pull failure; return the wait before the retry.

    ``None`` means the loop must end and re-raise ``exc``: a permanent
    failure that no ``error`` listener handles (the 0.2.0 behavior).
    """
    delay = pull_backoff_s(consecutive_failures)
    if is_transient_pull_error(exc):
        logger.debug("pull failed, retry in %.1fs: %s", delay, exc)
    elif not worker._has_listeners("error"):
        return None
    elif isinstance(exc, BunqueueError):
        logger.warning(
            "pull refused on queue %r (%s), retry in %.1fs: %s",
            worker.queue,
            type(exc).__name__,
            delay,
            exc,
        )
    else:
        logger.error(
            "unexpected pull failure on queue %r, retry in %.1fs: %r",
            worker.queue,
            delay,
            exc,
            exc_info=exc,
        )
    worker.emit("error", exc)
    return delay


def report_wire_failure(worker: Any, message: str, exc: Exception) -> None:
    """Report a swallowed RegisterWorker/Heartbeat/ACK/FAIL failure.

    Logged at warning level and emitted as ``error``. An exception that is
    not a ``BunqueueError`` (an SDK or protocol defect) also logs its
    traceback. The caller carries on: a heartbeat thread keeps beating, an
    ACK/FAIL path still releases the job's concurrency slot, and a failed
    registration is retried by the next poll (the pull itself then decides,
    under the policy above, whether the loop goes on).
    """
    logger.warning("%s: %s", message, exc, exc_info=not isinstance(exc, BunqueueError))
    worker.emit("error", exc)
