import type { Job } from '../types/jobs/model';
import { DEFAULT_MAX_BACKOFF, JOB_DEFAULTS } from './constants';
import { parseMaxDelay } from './create';
import { processingDeadline } from './timeoutRule';

/** 2^1023 is the largest finite power of two: a higher exponent would give 0 * Infinity. */
const MAX_BACKOFF_EXPONENT = 1023;

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

/**
 * Ready means "not delayed": the complement of `isDelayed`, as every state view
 * classifies jobs. A NaN run time (never valid) is therefore ready, not a job that is
 * reported waiting but can never be pulled.
 */
export function isReady(job: Job, now: number = Date.now()): boolean {
  return !(job.runAt > now);
}

export function isExpired(job: Job, now: number = Date.now()): boolean {
  if (job.ttl === null) return false;
  return now > job.createdAt + job.ttl;
}

/**
 * Whether a started job is past its processing deadline, by the rule the broker's
 * timeout scheduler and the Worker share (`timeoutRule.ts`): no timeout for an absent,
 * 0 or NaN `timeout`, a fractional deadline rounded up, and due at the deadline itself.
 */
export function isTimedOut(job: Job, now: number = Date.now()): boolean {
  const deadline = processingDeadline(job);
  return deadline !== null && now >= deadline;
}

/** A usable retry base: >= 0 (Infinity is capped later); anything else is the default. */
function retryBase(value: unknown): number {
  return typeof value === 'number' && value >= 0 ? value : JOB_DEFAULTS.backoff;
}

/**
 * Retry delay after a failure: always a finite number of milliseconds >= 0, whatever
 * the attempt count or a legacy job's stored values. `fixed` is the base with ±20%
 * jitter; otherwise `base * 2^attempts` with -50%..+50% jitter. Both are capped at
 * `backoff.maxDelay` (default 1 hour). A zero base retries at once for any attempt
 * count (no `0 * 2^1024 = NaN`), and a NaN or missing base uses the 1000 ms default.
 */
export function calculateBackoff(job: Job): number {
  const config = job.backoffConfig;
  const maxDelay = parseMaxDelay(config?.maxDelay) ?? DEFAULT_MAX_BACKOFF;
  const base = retryBase(config ? config.delay : job.backoff);
  if (config?.type === 'fixed') {
    return Math.min(base * (0.8 + Math.random() * 0.4), maxDelay);
  }
  if (base === 0) return 0;
  const exponent = job.attempts > 0 ? Math.min(job.attempts, MAX_BACKOFF_EXPONENT) : 0;
  return Math.min(base * Math.pow(2, exponent) * (0.5 + Math.random()), maxDelay);
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
