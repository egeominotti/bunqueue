/**
 * MCP view of a queue's limits, shared by both backends. The limit status comes from the
 * engine's getQueueLimitStatus (embedded) or the broker's `GetQueueLimits` reply (TCP),
 * which carry the same fields: `rateLimit` ({ max, duration } or null), `rateLimitTtl`
 * (-2 without a rate limit), `concurrencyLimit` and `maxed`.
 */

import type { QueueLimits } from '../types/adapter';

type Raw = Record<string, unknown>;

function invalid(): never {
  throw new Error('Invalid queue limits returned by the backend');
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rateLimitView(value: unknown): QueueLimits['rateLimit'] {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') invalid();
  const max = finite((value as Raw).max);
  const duration = finite((value as Raw).duration);
  if (max === null || duration === null) invalid();
  return { max, durationMs: duration };
}

/** Combine the limit status with the queue's active count and paused flag. */
export function queueLimitsView(
  queue: string,
  status: unknown,
  active: number,
  paused: boolean
): QueueLimits {
  if (status === null || typeof status !== 'object') invalid();
  const raw = status as Raw;
  const rateLimit = rateLimitView(raw.rateLimit);
  const ttl = finite(raw.rateLimitTtl);
  // The broker reports -2 when no rate limit is set.
  const rateLimitTtlMs = rateLimit === null || ttl === null || ttl < 0 ? null : ttl;
  const concurrencyLimit = raw.concurrencyLimit ?? null;
  if (concurrencyLimit !== null && finite(concurrencyLimit) === null) invalid();
  return {
    queue,
    paused,
    rateLimit,
    rateLimitTtlMs,
    rateLimited: rateLimitTtlMs !== null && rateLimitTtlMs > 0,
    concurrencyLimit: concurrencyLimit as number | null,
    active,
    concurrencyMaxed: raw.maxed === true,
  };
}
