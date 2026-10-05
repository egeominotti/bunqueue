/**
 * MCP views of dead letter entries and DLQ statistics, shared by both backends: the
 * embedded engine's DlqEntry/DlqStats objects and the TCP broker's `Dlq`/`GetDlqStats`
 * replies have the same fields, so one builder keeps the two modes identical. Output is
 * bounded: only the most recent attempts are listed and error texts are truncated.
 */

import { isoTime } from '../workflow/jsonSafe';
import type {
  SerializedDlqAttempt,
  SerializedDlqEntry,
  SerializedDlqStats,
  SerializedJob,
} from '../types/adapter';

/** Most recent attempt records listed per entry; `attemptCount` reports the full total. */
export const MAX_DLQ_ATTEMPTS_SHOWN = 10;
/** Longest error text returned; longer messages end with a truncation marker. */
export const MAX_DLQ_ERROR_CHARS = 1000;

type Raw = Record<string, unknown>;

function invalid(what: string): never {
  throw new Error(`Invalid ${what} returned by the backend`);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoOrNull(value: unknown): string | null {
  return isoTime(value);
}

function errorText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length <= MAX_DLQ_ERROR_CHARS) return value;
  return `${value.slice(0, MAX_DLQ_ERROR_CHARS)}… [truncated, ${value.length} chars]`;
}

function attemptView(value: unknown): SerializedDlqAttempt {
  if (value === null || typeof value !== 'object') invalid('DLQ attempt record');
  const record = value as Raw;
  return {
    attempt: finite(record.attempt) ?? 0,
    reason: typeof record.reason === 'string' ? record.reason : 'unknown',
    error: errorText(record.error),
    startedAt: isoOrNull(record.startedAt),
    failedAt: isoOrNull(record.failedAt),
    durationMs: finite(record.duration) ?? 0,
  };
}

/** One DLQ entry; `job` is the entry's job already serialized by the calling backend. */
export function dlqEntryView(entry: Raw, job: SerializedJob): SerializedDlqEntry {
  const enteredAt = finite(entry.enteredAt);
  if (enteredAt === null || typeof entry.reason !== 'string') invalid('DLQ entry');
  const history = Array.isArray(entry.attempts) ? (entry.attempts as unknown[]) : [];
  return {
    job,
    reason: entry.reason,
    error: errorText(entry.error),
    attempts: history.slice(-MAX_DLQ_ATTEMPTS_SHOWN).map(attemptView),
    attemptCount: history.length,
    retryCount: finite(entry.retryCount) ?? 0,
    enteredAt: new Date(enteredAt).toISOString(),
    lastRetryAt: isoOrNull(entry.lastRetryAt),
    nextRetryAt: isoOrNull(entry.nextRetryAt),
    expiresAt: isoOrNull(entry.expiresAt),
  };
}

/** The job carried by a raw DLQ entry, or an error when the entry has none. */
export function dlqEntryJob(entry: unknown): Raw {
  if (entry === null || typeof entry !== 'object') invalid('DLQ entry');
  const job = (entry as Raw).job;
  if (job === null || typeof job !== 'object') invalid('DLQ entry');
  return job as Raw;
}

/** DLQ statistics of one queue (the per-queue breakdown is dropped: it is always this queue). */
export function dlqStatsView(stats: unknown): SerializedDlqStats {
  if (stats === null || typeof stats !== 'object') invalid('DLQ stats');
  const raw = stats as Raw;
  const total = finite(raw.total);
  if (total === null) invalid('DLQ stats');
  const byReason: Record<string, number> = {};
  if (raw.byReason !== null && typeof raw.byReason === 'object') {
    for (const [reason, count] of Object.entries(raw.byReason as Raw)) {
      byReason[reason] = finite(count) ?? 0;
    }
  }
  return {
    total,
    byReason,
    pendingRetry: finite(raw.pendingRetry) ?? 0,
    expired: finite(raw.expired) ?? 0,
    oldestEntry: isoOrNull(raw.oldestEntry),
    newestEntry: isoOrNull(raw.newestEntry),
  };
}
