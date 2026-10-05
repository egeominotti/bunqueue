/**
 * Bunqueue — Advanced Retry with backoff strategies
 *
 * Every wait is armed with `safeTimeout`, so any finite delay is honoured exactly: one
 * longer than the runtime's 2^31 - 1 ms timer limit is armed in chunks and is never
 * early. The documented formulas have no cap; they saturate at MAX_RETRY_DELAY_MS
 * instead of overflowing to Infinity (or to NaN for a zero base).
 */

import { assertDuration } from '../../shared/durations';
import { safeTimeout, type SafeTimer } from '../../shared/timers';
import { coerceNumericString } from '../tcp/numeric';
import type { RetryConfig, RetryStrategy } from './types';

/** Saturation point of computed backoffs: Number.MAX_SAFE_INTEGER ms (about 285,000 years). */
export const MAX_RETRY_DELAY_MS = Number.MAX_SAFE_INTEGER;

const CUSTOM_RESULT = 'Bunqueue: the delay returned by retry.customBackoff';

/** `base * factor` for a validated base (finite, >= 0): never Infinity, never NaN. */
function scaled(base: number, factor: number): number {
  if (base === 0) return 0; // 0 * Infinity would be NaN
  const delay = base * factor;
  return delay < MAX_RETRY_DELAY_MS ? delay : MAX_RETRY_DELAY_MS;
}

/** 1, 2, 3, 5, 8, ... for attempts 1, 2, 3, ...; stops once the delay saturates. */
function fibonacciFactor(attempt: number, base: number): number {
  let a = 1;
  let b = 1;
  for (let i = 1; i < attempt && base * b < MAX_RETRY_DELAY_MS; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return b;
}

/**
 * A customBackoff result is a finite number of milliseconds. As on 2.9.10, whose timer
 * ran it at once, a negative number, NaN, `undefined` or `null` retries at once (0),
 * and a numeric string is that number. Infinity (2.9.10 retried after ~1 ms) or another
 * non-number fails the attempt loop with a TypeError or RangeError whose `cause` is the
 * processor error, instead of retrying.
 */
function customDelay(
  customBackoff: NonNullable<RetryConfig['customBackoff']>,
  attempt: number,
  error: Error
): number {
  const delay = coerceNumericString(customBackoff(attempt, error));
  if (delay === undefined || delay === null) return 0;
  if (typeof delay === 'number' && !(delay >= 0)) return 0;
  try {
    return assertDuration(delay, CUSTOM_RESULT);
  } catch (invalid) {
    (invalid as Error).cause = error;
    throw invalid;
  }
}

/** Calculate backoff delay based on strategy: always a finite number >= 0 */
export function calculateBackoff(
  strategy: RetryStrategy,
  attempt: number,
  baseDelay: number,
  error: Error,
  config: RetryConfig
): number {
  switch (strategy) {
    case 'fixed':
      return baseDelay;

    case 'exponential':
      return scaled(baseDelay, 2 ** (attempt - 1));

    case 'jitter': {
      const jittered = Math.floor(scaled(baseDelay, 2 ** (attempt - 1)) * (0.5 + Math.random()));
      return jittered < MAX_RETRY_DELAY_MS ? jittered : MAX_RETRY_DELAY_MS;
    }

    case 'fibonacci':
      return baseDelay === 0 ? 0 : scaled(baseDelay, fibonacciFactor(attempt, baseDelay));

    case 'custom':
      if (config.customBackoff) {
        return customDelay(config.customBackoff, attempt, error);
      }
      return baseDelay;

    default:
      return baseDelay;
  }
}

function cancellationError(): Error {
  return new Error('Job cancelled');
}

function waitForRetry<R>(delay: number, next: () => Promise<R>, signal?: AbortSignal): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancellationError());
      return;
    }

    let timer: SafeTimer | null = null;
    const onAbort = () => {
      timer?.clear();
      timer = null;
      signal?.removeEventListener('abort', onAbort);
      reject(cancellationError());
    };
    timer = safeTimeout(() => {
      timer = null;
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(cancellationError());
        return;
      }
      resolve(next());
    }, delay);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Execute a function with retry logic */
export function executeWithRetry<R>(
  fn: () => Promise<R>,
  config: RetryConfig,
  signal?: AbortSignal
): Promise<R> {
  const maxAttempts = config.maxAttempts ?? 3;
  const baseDelay = config.delay ?? 1000;
  const strategy = config.strategy ?? 'exponential';

  const attempt = (n: number): Promise<R> => {
    if (signal?.aborted) return Promise.reject(cancellationError());
    let execution: Promise<R>;
    try {
      execution = fn();
    } catch (error) {
      execution = Promise.reject(error);
    }
    return execution.catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (signal?.aborted) throw cancellationError();
      if (n >= maxAttempts) throw error;
      if (config.retryIf && !config.retryIf(error, n)) throw error;

      const delay = calculateBackoff(strategy, n, baseDelay, error, config);
      return waitForRetry(delay, () => attempt(n + 1), signal);
    });
  };

  return attempt(1);
}
