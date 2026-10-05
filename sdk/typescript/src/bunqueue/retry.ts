/**
 * Bunqueue Simple Mode — advanced in-process retry with backoff strategies.
 * 1:1 port of src/client/bunqueue/retry.ts (identical formulas and limits).
 *
 * Every wait is armed with `safeTimeout`, so any finite delay is honoured exactly: one
 * longer than the runtime's 2^31 - 1 ms timer limit is armed in chunks and is never
 * early. The documented formulas have no cap; they saturate at MAX_RETRY_DELAY_MS
 * instead of overflowing to Infinity (or to NaN for a zero base). An aborted signal
 * (cancel() or close()) ends a pending wait with `Job cancelled`.
 *
 * Every other result of 0.2.2 is kept (`../legacy-coercion.ts`): `maxAttempts` is
 * compared as given (0 or below is one attempt), an unknown strategy is a fixed delay,
 * and a delay that is a numeric string is its number, while a NaN or negative one
 * retries at once.
 */

import { legacyDelay } from '../legacy-coercion.js';
import { type SafeTimer, safeTimeout } from '../timing.js';
import type { RetryConfig, RetryStrategy } from './types.js';

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
 * A customBackoff result is a delay as 0.2.2's setTimeout read it: a numeric string is
 * its number, and NaN, a negative number, `undefined` or `null` retries at once. A
 * result that 0.2.2 fired after about 1 ms instead of honouring (Infinity), or that is
 * neither a number nor a numeric string, fails the attempt loop with a RangeError or
 * TypeError whose `cause` is the processor error, instead of retrying.
 */
function customDelay(
  customBackoff: NonNullable<RetryConfig['customBackoff']>,
  attempt: number,
  error: Error
): number {
  const delay: unknown = customBackoff(attempt, error);
  try {
    return legacyDelay(delay ?? 0, CUSTOM_RESULT);
  } catch (invalid) {
    (invalid as Error).cause = error;
    throw invalid;
  }
}

/** Calculate the backoff delay for a strategy: always a finite number >= 0. */
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

/** Execute a function with retry logic (the job stays active throughout). */
export function executeWithRetry<R>(
  fn: () => Promise<R>,
  config: RetryConfig,
  signal?: AbortSignal
): Promise<R> {
  const maxAttempts = config.maxAttempts ?? 3;
  const strategy = config.strategy ?? 'exponential';
  let baseDelay: number;
  try {
    baseDelay = legacyDelay(config.delay ?? 1000, 'Bunqueue: retry.delay');
  } catch (invalid) {
    return Promise.reject(invalid);
  }

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
