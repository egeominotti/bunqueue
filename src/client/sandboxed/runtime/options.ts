/**
 * Boundary validation for the SandboxedWorker numeric options.
 *
 * A NaN, infinite or sub-millisecond period used to reach a timer or Bun.sleep, which
 * turned it into a ~1 ms interval or a hot pull loop, and an infinite `concurrency`
 * made start() spawn threads endlessly. The constructor resolves these options here,
 * before it acquires a TCP pool or the shared embedded manager, and throws a TypeError
 * or RangeError naming the option. Long durations stay valid: the timer helpers
 * honour them. Values 2.9.10 read with a well-defined result keep it: a numeric string
 * is that number (`tcp/numeric.ts`), an "after this many ms" option that is not above 0
 * (NaN included) is disabled, and a finite `concurrency` is rounded up, at least 1.
 */

import { assertDuration, describeValue } from '../../../shared/durations';
import { ceilAtLeast, coerceNumericString, isFiniteNumber } from '../../tcp/numeric';
import type { SandboxedWorkerOptions } from '../types';

/** Resolved durations in ms; 0 means disabled where the option allows it. */
export interface SandboxedDurations {
  timeout: number;
  pollInterval: number;
  heartbeatInterval: number;
  idleTimeout: number;
  idleRecycleMs: number;
  autoStartPollMs: number;
}

const OWNER = 'SandboxedWorker';

/**
 * "After this many ms": a finite number > 0, or disabled (stored as 0). 0 disables
 * (documented); Infinity means "never" and disables as well; a negative value or NaN
 * disables too, as 2.9.10 read every one of these options only when `> 0`.
 */
function delayOrNever(raw: unknown, name: string, fallback: number): number {
  const value = coerceNumericString(raw ?? fallback);
  if (typeof value === 'number' && !(value > 0 && value < Infinity)) return 0;
  return assertDuration(value, `${OWNER}: ${name}`);
}

/**
 * A period re-armed while the worker runs: finite and at least 1 ms. Below timer
 * resolution Bun.sleep resolves at once and a native interval ticks every ~1 ms.
 */
function period(raw: unknown, name: string, fallback: number): number {
  return assertDuration(coerceNumericString(raw ?? fallback), `${OWNER}: ${name}`, { min: 1 });
}

/** A non-positive heartbeatInterval disables heartbeats (documented); stored as 0. */
function heartbeatPeriod(raw: unknown, fallback: number): number {
  const ms = coerceNumericString(raw ?? fallback);
  if (typeof ms === 'number' && ms <= 0) return 0;
  return period(ms, 'heartbeatInterval', fallback);
}

/**
 * The number of threads start() spawns. 2.9.10 spawned slot 0 and then
 * `for (i = 1; i < concurrency; i++)`, so a value below 1 starts 1 thread and a finite
 * one is rounded up (2.5 starts 3). Infinity (endless spawning), NaN and a value beyond
 * `Number.MAX_SAFE_INTEGER` throw.
 */
export function resolveConcurrency(raw: number | undefined): number {
  const value = coerceNumericString(raw ?? 1);
  if (typeof value === 'number' && value < 1) return 1;
  if (isFiniteNumber(value) && Number.isSafeInteger(Math.ceil(value))) {
    return ceilAtLeast(value, 1);
  }
  const message = `${OWNER}: concurrency must be a finite number of threads (got ${describeValue(value)})`;
  throw typeof value === 'number' ? new RangeError(message) : new TypeError(message);
}

export function resolveSandboxedDurations(
  options: SandboxedWorkerOptions,
  tcp: boolean
): SandboxedDurations {
  return {
    timeout: delayOrNever(options.timeout, 'timeout', 30000),
    pollInterval: period(options.pollInterval, 'pollInterval', 10),
    heartbeatInterval: heartbeatPeriod(options.heartbeatInterval, tcp ? 10000 : 5000),
    idleTimeout: delayOrNever(options.idleTimeout, 'idleTimeout', 0),
    idleRecycleMs: delayOrNever(options.idleRecycleMs, 'idleRecycleMs', 30000),
    autoStartPollMs: period(options.autoStartPollMs, 'autoStartPollMs', 5000),
  };
}
