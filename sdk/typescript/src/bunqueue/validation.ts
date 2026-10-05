/**
 * Bunqueue Simple Mode — option validation at the constructor boundary.
 *
 * A duration that would arm a timer the runtime turns into a 1 ms spin, or a value that
 * made 0.2.2 hang or crash, is rejected here, before the Queue and Worker exist, with a
 * TypeError (not a number) or a RangeError (out of range) naming the option. Every
 * other value keeps the result 0.2.2 gave it (`../legacy-coercion.ts`), so an option
 * that worked in 0.2.2 still constructs and behaves the same:
 *
 * - compared as 0.2.2 compared them, never rejected: `retry.maxAttempts` (0 or below is
 *   one attempt, a fraction rounds up, NaN retries until cancel() or close()),
 *   `circuitBreaker.threshold` (0 opens on the first failure, NaN never opens),
 *   `batch.size` (0 flushes every job, omitted flushes on `timeout` only),
 *   `priorityAging.minAge` and `maxPriority`;
 * - one-shot delays (`retry.delay`, `circuitBreaker.resetTimeout`, `batch.timeout`):
 *   a numeric string is its number, NaN or negative runs at once, Infinity throws
 *   (except `resetTimeout`, where it stays open until resetCircuit());
 * - `retry.strategy`, `customBackoff` and `retryIf` are not checked: an unknown strategy
 *   is a fixed delay, and a callback that is not a function fails the job when it is
 *   called, as in 0.2.2;
 * - `priorityAging.interval` (a repeating timer) must be >= 1 ms and finite; `boost` must
 *   be a number (a string concatenated onto the priority in 0.2.2); `maxScan: Infinity`
 *   crashed 0.2.2's tick and throws;
 * - `rateLimit` / `limiter`: `max` must be > 0 (0, NaN or omitted waited forever on a
 *   ~1 ms poll); `duration: Infinity` never frees and throws; 0, negative, NaN or an
 *   omitted `duration` means no limit, as in 0.2.2;
 * - `pollTimeout` follows the Worker's clamp; a value that is neither a number nor a
 *   numeric string throws under the main client's name. `heartbeatInterval` is not
 *   checked: the Worker disables heartbeats for 0, negative, non-finite and non-number
 *   intervals (sdk/CLAUDE.md rule 4).
 */

import { legacyDelay, numericString } from '../legacy-coercion.js';
import { clampPollTimeout } from '../sdk-clamps.js';
import { assertDuration, describeValue } from '../timing.js';
import type { BunqueueOptions } from './types.js';

type Fields = Readonly<Record<string, unknown>>;

/** Throw for the first invalid option; return normally when all are valid. */
export function validateBunqueueOptions<T, R>(options: BunqueueOptions<T, R>): void {
  if (options.retry) delay(options.retry as Fields, 'retry.delay');
  if (options.circuitBreaker)
    delay(options.circuitBreaker as Fields, 'circuitBreaker.resetTimeout');
  if (options.batch) delay(options.batch as unknown as Fields, 'batch.timeout');
  if (options.priorityAging) validatePriorityAging(options.priorityAging as Fields);
  // rateLimit takes precedence over limiter: only the one in effect is checked.
  if (options.rateLimit) validateRateLimit(options.rateLimit as unknown as Fields, 'rateLimit');
  else if (options.limiter) validateRateLimit(options.limiter as unknown as Fields, 'limiter');
  const poll = (options as Fields).pollTimeout;
  if (poll !== undefined && poll !== null) clampPollTimeout(poll, 'Worker: pollTimeout');
}

function delay(fields: Fields, option: string): void {
  const value = fields[field(option)];
  if (value === undefined || value === null) return;
  legacyDelay(value, `Bunqueue: ${option}`, option === 'circuitBreaker.resetTimeout');
}

function validatePriorityAging(aging: Fields): void {
  const interval = aging.interval;
  if (interval !== undefined && interval !== null) {
    // A period below 1 ms is rounded up to 1 ms by the runtime: 1 is the smallest honest one.
    assertDuration(numericString(interval), 'Bunqueue: priorityAging.interval', { min: 1 });
  }
  const boost = aging.boost;
  if (boost !== undefined && boost !== null && typeof boost !== 'number') {
    fail(boost, 'priorityAging.boost', 'a number', TypeError);
  }
  if (numericString(aging.maxScan) === Infinity) {
    fail(aging.maxScan, 'priorityAging.maxScan', 'a finite number of jobs', RangeError);
  }
}

function validateRateLimit(limiter: Fields, option: 'rateLimit' | 'limiter'): void {
  const max = numericString(limiter.max);
  if (!(typeof max === 'number' && max > 0)) {
    const ErrorType = typeof max === 'number' ? RangeError : TypeError;
    fail(limiter.max, `${option}.max`, 'a number of job starts > 0', ErrorType);
  }
  if (numericString(limiter.duration) === Infinity) {
    fail(limiter.duration, `${option}.duration`, 'a finite number of milliseconds', RangeError);
  }
}

function fail(
  value: unknown,
  option: string,
  expected: string,
  ErrorType: ErrorConstructor
): never {
  throw new ErrorType(`Bunqueue: ${option} must be ${expected} (got ${describeValue(value)})`);
}

function field(option: string): string {
  return option.slice(option.indexOf('.') + 1);
}
