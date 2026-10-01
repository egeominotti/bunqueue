export const DEFAULT_MAX_BACKOFF = 3_600_000;
export const MAX_TIMELINE_ENTRIES = 20;
export const DEFAULT_LOCK_TTL = 30_000;

export const JOB_DEFAULTS = {
  priority: 0,
  maxAttempts: 3,
  backoff: 1000,
  lifo: false,
  removeOnComplete: false,
  removeOnFail: false,
  stackTraceLimit: 10,
} as const;

/** Upper bound accepted for `backoff`, `backoff.delay` and `backoff.maxDelay` (24 hours). */
export const MAX_BACKOFF_DELAY = 86_400_000;
