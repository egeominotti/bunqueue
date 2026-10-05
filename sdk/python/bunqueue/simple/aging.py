"""Priority aging: boost old waiting jobs so they never starve (mirror of
aging.ts, adapted to the TCP query surface)."""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, Optional

from ..durations import wait_seconds
from ..queue import Queue
from .validation import option

logger = logging.getLogger("bunqueue")


class PriorityAger:
    def __init__(self, config: Dict[str, Any], queue: Queue) -> None:
        self._config = config
        self._queue = queue
        self._timer: Optional[threading.Timer] = None
        self._stopped = False

    def start(self) -> None:
        self._schedule()

    def _schedule(self) -> None:
        if self._stopped:
            return
        # 0 means 60000 ms, as in 0.2.0. Bunqueue rejects a NaN or negative
        # interval (it fired at once and re-armed itself, a hot loop of aging
        # queries) and an infinite one (it crashed the Timer thread).
        interval = float(option(self._config, "interval", None, 60000))
        self._timer = threading.Timer(wait_seconds(interval), self._tick)
        self._timer.daemon = True
        self._timer.start()

    def _tick(self) -> None:
        try:
            self._boost_old_jobs()
        except Exception:  # noqa: BLE001 - best-effort background task
            logger.warning("priority aging tick failed", exc_info=True)
        finally:
            self._schedule()

    def _boost_old_jobs(self) -> None:
        min_age = float(option(self._config, "min_age", "minAge", 60000))
        boost = int(option(self._config, "boost", None, 1))
        max_priority = int(option(self._config, "max_priority", "maxPriority", 100))
        max_scan = int(option(self._config, "max_scan", "maxScan", 100))

        jobs = self._queue.get_waiting(0, max_scan) + self._queue.get_jobs(
            "prioritized", 0, max_scan
        )
        now = time.time() * 1000
        for job in jobs:
            created = job.created_at or now
            age = now - created
            if age >= min_age and job.priority < max_priority:
                new_priority = min(job.priority + boost, max_priority)
                try:
                    self._queue.change_job_priority(job.id, new_priority)
                except Exception:  # noqa: BLE001 - job may have been processed
                    pass

    def destroy(self) -> None:
        self._stopped = True
        if self._timer:
            self._timer.cancel()
            self._timer = None
