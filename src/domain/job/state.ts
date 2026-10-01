import type { Job } from '../types/jobs/model';
import { DEFAULT_MAX_BACKOFF, JOB_DEFAULTS } from './constants';

export function normalizeStacktrace(
  lines: readonly unknown[] | undefined,
  limit: number
): string[] | null {
  if (!lines || lines.length === 0) return null;
  const out: string[] = [];
  for (const line of lines) {
    if (out.length >= limit) break;
    if (typeof line !== 'string') continue;
    const trimmed = line.trim();
    if (trimmed) out.push(trimmed);
  }
  return out.length > 0 ? out : null;
}

export function isDelayed(job: Job, now: number = Date.now()): boolean {
  return job.runAt > now;
}

export function isReady(job: Job, now: number = Date.now()): boolean {
  return job.runAt <= now;
}

export function isExpired(job: Job, now: number = Date.now()): boolean {
  if (job.ttl === null) return false;
  return now > job.createdAt + job.ttl;
}

export function isTimedOut(job: Job, now: number = Date.now()): boolean {
  if (job.timeout === null || job.startedAt === null) return false;
  return now > job.startedAt + job.timeout;
}

export function calculateBackoff(job: Job): number {
  const maxDelay = job.backoffConfig?.maxDelay ?? DEFAULT_MAX_BACKOFF;

  if (job.backoffConfig) {
    if (job.backoffConfig.type === 'fixed') {
      const base = job.backoffConfig.delay;
      const jittered = base * (0.8 + Math.random() * 0.4);
      return Math.min(jittered, maxDelay);
    }
    const base = job.backoffConfig.delay * Math.pow(2, job.attempts);
    const jittered = base * (0.5 + Math.random());
    return Math.min(jittered, maxDelay);
  }

  const base = job.backoff * Math.pow(2, job.attempts);
  const jittered = base * (0.5 + Math.random());
  return Math.min(jittered, maxDelay);
}

/**
 * Wait applied when a processor throws `DelayedError`. It is always a positive
 * finite number of milliseconds: DelayedError never counts an attempt, so a zero
 * wait would let a processor that keeps throwing it re-pull the job in a tight
 * loop with nothing to stop it.
 *
 * The base is the configured delay with no attempt growth and no jitter:
 * `backoff.delay` for the object form, otherwise the numeric `backoff`. A base
 * that is not a positive number (0, missing, negative or NaN) falls back to the
 * 1000 ms default. The base is then capped at `backoff.maxDelay` when that is a
 * positive finite number, otherwise at DEFAULT_MAX_BACKOFF. A `maxDelay` of 0
 * means "retry failures immediately" and does not apply here, because
 * DelayedError is not a failure: such a job waits its capped base delay.
 */
export function calculateDelayedErrorDelay(job: Pick<Job, 'backoff' | 'backoffConfig'>): number {
  const base = job.backoffConfig ? job.backoffConfig.delay : job.backoff;
  const maxDelay = job.backoffConfig?.maxDelay;
  const cap = isPositiveFinite(maxDelay) ? maxDelay : DEFAULT_MAX_BACKOFF;
  const wait = typeof base === 'number' && base > 0 ? base : JOB_DEFAULTS.backoff;
  return Math.min(wait, cap);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function canRetry(job: Job): boolean {
  return job.attempts < job.maxAttempts;
}
