/** MCP views of dead letter entries, DLQ statistics and queue limits. */

import type { SerializedJob } from './adapter';

/** One failed attempt recorded in a DLQ entry's history. */
export interface SerializedDlqAttempt {
  attempt: number;
  reason: string;
  error: string | null;
  startedAt: string | null;
  failedAt: string | null;
  durationMs: number;
}

/** A dead letter entry: the job plus why and when it failed. */
export interface SerializedDlqEntry {
  job: SerializedJob;
  /** Last failure reason (explicit_fail, max_attempts_exceeded, timeout, stalled, ...). */
  reason: string;
  /** Last error message (truncated when very long). */
  error: string | null;
  /** The most recent attempt records, oldest first (bounded; see attemptCount). */
  attempts: SerializedDlqAttempt[];
  /** Total attempt records the entry holds. */
  attemptCount: number;
  /** Times the entry was retried out of the DLQ automatically. */
  retryCount: number;
  enteredAt: string;
  lastRetryAt: string | null;
  nextRetryAt: string | null;
  expiresAt: string | null;
}

export interface DlqQuery {
  limit: number;
  offset?: number;
  reason?: string;
}

export interface SerializedDlqStats {
  total: number;
  byReason: Record<string, number>;
  /** Entries whose automatic DLQ retry is due. */
  pendingRetry: number;
  /** Entries past their expiry, awaiting purge. */
  expired: number;
  oldestEntry: string | null;
  newestEntry: string | null;
}

/** What the broker knows about a queue's throughput limits. */
export interface QueueLimits {
  queue: string;
  paused: boolean;
  /** `max` jobs may start per `durationMs` window; null = no rate limit. */
  rateLimit: { max: number; durationMs: number } | null;
  /**
   * The broker's rate-limit TTL: ms until the bucket admits the next job, or until a
   * temporary limit expires; null without a rate limit.
   */
  rateLimitTtlMs: number | null;
  rateLimited: boolean;
  concurrencyLimit: number | null;
  /** Jobs of the queue currently active. */
  active: number;
  /** All concurrency slots are taken: the next pull of this queue gets nothing. */
  concurrencyMaxed: boolean;
}
