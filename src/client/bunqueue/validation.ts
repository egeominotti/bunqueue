/**
 * Bunqueue — option validation and normalization at the constructor boundary.
 *
 * A duration that reaches a repeating timer as NaN, Infinity or a sub-millisecond
 * period would otherwise spin, and a NaN aging boost writes NaN priorities. Each is
 * rejected here, before the Queue and Worker exist, with a TypeError (not a number) or
 * a RangeError (out of range) naming the option. `undefined` and `null` keep the
 * documented defaults.
 *
 * Every other value keeps the result 2.9.10 gave it, rewritten into a normalized copy
 * (the same decisions as the legacy entry, `sdk/typescript/src/bunqueue/validation.ts`):
 * a numeric string is that number; `retry.maxAttempts`, `circuitBreaker.threshold` and
 * `batch.size` are compared with `>=`, so a value below 1 acts as 1, a fraction as the
 * next whole number and NaN (or an omitted `batch.size`) as no limit; a one-shot delay
 * (`retry.delay`, `circuitBreaker.resetTimeout`, `batch.timeout`) that is negative or
 * NaN is 0; an unknown `retry.strategy` is a fixed delay, with one warning. See
 * docs/features/simple-mode.md, "Option validation".
 */

import { assertDuration, describeValue, type DurationOptions } from '../../shared/durations';
import { ceilAtLeast, coerceNumericString } from '../tcp/numeric';
import type {
  BatchConfig,
  BunqueueOptions,
  CircuitBreakerConfig,
  PriorityAgingConfig,
  RetryConfig,
} from './types';

type Fields = Readonly<Record<string, unknown>>;

const RETRY_STRATEGIES: readonly string[] = [
  'fixed',
  'exponential',
  'jitter',
  'fibonacci',
  'custom',
];

/** The feature configs the runtime reads, normalized; null when not configured. */
export interface BunqueueFeatures<T, R> {
  retry: RetryConfig | null;
  circuitBreaker: CircuitBreakerConfig | null;
  batch: BatchConfig<T, R> | null;
  priorityAging: PriorityAgingConfig | null;
}

/**
 * Throw for the first invalid feature option; otherwise return copies of the feature
 * configs with every value normalized (the caller's objects are never modified).
 */
export function resolveBunqueueFeatures<T, R>(
  options: BunqueueOptions<T, R>
): BunqueueFeatures<T, R> {
  return {
    retry: options.retry ? resolveRetry(options.retry) : null,
    circuitBreaker: options.circuitBreaker ? resolveCircuitBreaker(options.circuitBreaker) : null,
    batch: options.batch ? resolveBatch(options.batch) : null,
    priorityAging: options.priorityAging ? resolvePriorityAging(options.priorityAging) : null,
  };
}

function resolveRetry(retry: RetryConfig): RetryConfig {
  const fields = retry as Fields;
  const resolved: Record<string, unknown> = { ...retry };
  set(resolved, 'maxAttempts', count(fields, 'retry.maxAttempts'));
  set(resolved, 'delay', delay(fields, 'retry.delay'));
  const strategy = retry.strategy;
  if (!isNullish(strategy) && !RETRY_STRATEGIES.includes(strategy as string)) {
    // 2.9.10 ran any other value as a fixed delay (calculateBackoff's default branch).
    warn(
      `Bunqueue: unknown retry.strategy ${describeValue(strategy)} (expected one of ` +
        `${RETRY_STRATEGIES.join(', ')}); retrying with a fixed delay`
    );
  }
  // 2.9.10 ignored a falsy callback; a non-function is rejected only where it is called.
  callback(resolved, fields, 'retry.customBackoff', strategy === 'custom');
  callback(resolved, fields, 'retry.retryIf', true);
  return resolved as RetryConfig;
}

function resolveCircuitBreaker(circuitBreaker: CircuitBreakerConfig): CircuitBreakerConfig {
  const fields = circuitBreaker as Fields;
  const resolved: Record<string, unknown> = { ...circuitBreaker };
  // Infinity (or NaN, never reached by `>=`): a breaker that never opens.
  set(resolved, 'threshold', count(fields, 'circuitBreaker.threshold'));
  // Infinity: one that stays open until resetCircuit().
  set(
    resolved,
    'resetTimeout',
    delay(fields, 'circuitBreaker.resetTimeout', { allowInfinity: true })
  );
  return resolved as CircuitBreakerConfig;
}

function resolveBatch<T, R>(batch: BatchConfig<T, R>): BatchConfig<T, R> {
  const fields = batch as unknown as Fields;
  const resolved: Record<string, unknown> = { ...batch };
  // size: Infinity (or omitted/NaN, which 2.9.10's `length >= size` never reached)
  // flushes on `timeout` (or close) only; each buffered job holds a slot.
  resolved.size = count(fields, 'batch.size') ?? Infinity;
  set(resolved, 'timeout', delay(fields, 'batch.timeout'));
  return resolved as unknown as BatchConfig<T, R>;
}

function resolvePriorityAging(aging: PriorityAgingConfig): PriorityAgingConfig {
  const fields = aging as Fields;
  const resolved: Record<string, unknown> = { ...aging };
  // A period below 1 ms is rounded up to 1 ms by the runtime: 1 is the smallest honest one.
  set(resolved, 'interval', duration(fields, 'priorityAging.interval', { min: 1 }));
  // `age >= minAge`: a negative threshold ages every job (0); NaN or Infinity none.
  const minAge = number(fields, 'priorityAging.minAge');
  set(resolved, 'minAge', minAge !== undefined && minAge < 0 ? 0 : minAge);
  // Any number but NaN, which wrote NaN priorities: 0 never ages, a negative boost lowers.
  const boost = number(fields, 'priorityAging.boost');
  if (boost !== undefined && Number.isNaN(boost)) {
    fail(boost, 'priorityAging.boost', 'a number other than NaN', 'number');
  }
  set(resolved, 'boost', boost);
  // Any number: Infinity is no cap (`Math.min(priority + boost, Infinity)`).
  set(resolved, 'maxPriority', number(fields, 'priorityAging.maxPriority'));
  // maxScan bounds the work of every tick (two queries, one update per job found);
  // Infinity crashed 2.9.10's tick.
  const maxScan = number(fields, 'priorityAging.maxScan');
  if (maxScan === Infinity) fail(maxScan, 'priorityAging.maxScan', 'a finite number', 'number');
  set(resolved, 'maxScan', maxScan);
  return resolved as PriorityAgingConfig;
}

/** Store a normalized value; `undefined` leaves the caller's value (or its absence). */
function set(target: Record<string, unknown>, key: string, value: number | undefined): void {
  if (value !== undefined) target[key] = value;
}

/** A period: validated as given (numeric strings coerced), never rewritten. */
function duration(fields: Fields, option: string, opts: DurationOptions = {}): number | undefined {
  const value = coerceNumericString(fields[field(option)]);
  if (isNullish(value)) return undefined;
  return assertDuration(value, `Bunqueue: ${option}`, opts);
}

/**
 * A one-shot delay: a negative value or NaN is 0, when 2.9.10's timer ran it.
 * Infinity is accepted only with `allowInfinity` (2.9.10 fired it after ~1 ms).
 */
function delay(fields: Fields, option: string, opts: DurationOptions = {}): number | undefined {
  const value = coerceNumericString(fields[field(option)]);
  if (isNullish(value)) return undefined;
  if (typeof value === 'number' && !(value >= 0)) return 0;
  return assertDuration(value, `Bunqueue: ${option}`, opts);
}

/**
 * A count compared with `>=`: a finite value is rounded up and raised to 1, as 2.9.10's
 * comparisons read it; NaN, Infinity and a value above `Number.MAX_SAFE_INTEGER` are
 * never reached (Infinity, no limit). A non-number throws.
 */
function count(fields: Fields, option: string): number | undefined {
  const value = coerceNumericString(fields[field(option)]);
  if (isNullish(value)) return undefined;
  if (typeof value !== 'number') fail(value, option, 'a number', 'number');
  if (Number.isNaN(value) || value > Number.MAX_SAFE_INTEGER) return Infinity;
  return ceilAtLeast(value, 1);
}

/** Any number (a numeric string coerced); a non-number throws a TypeError. */
function number(fields: Fields, option: string): number | undefined {
  const value = coerceNumericString(fields[field(option)]);
  if (isNullish(value)) return undefined;
  if (typeof value !== 'number') fail(value, option, 'a number', 'number');
  return value;
}

/** Drop a falsy callback (2.9.10 ignored it); reject a non-function when it is called. */
function callback(
  resolved: Record<string, unknown>,
  fields: Fields,
  option: string,
  called: boolean
): void {
  const value = fields[field(option)];
  if (!value) {
    if (value !== undefined) resolved[field(option)] = undefined;
    return;
  }
  if (typeof value !== 'function' && called) fail(value, option, 'a function', 'function');
}

/** RangeError when the value has the expected type, TypeError otherwise. */
function fail(value: unknown, option: string, expected: string, type: string): never {
  const ErrorType = typeof value === type ? RangeError : TypeError;
  throw new ErrorType(`Bunqueue: ${option} must be ${expected} (got ${describeValue(value)})`);
}

/** One line on the console; reporting must never throw. */
function warn(line: string): void {
  try {
    console.warn(line);
  } catch {
    // A broken console cannot fail the constructor.
  }
}

function field(option: string): string {
  return option.slice(option.indexOf('.') + 1);
}

function isNullish(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}
