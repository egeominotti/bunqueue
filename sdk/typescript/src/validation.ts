/**
 * Boundary validation for the legacy Connection, ConnectionPool, Queue and Worker
 * options, with the main client's bounds and messages (src/client/tcp/options.ts,
 * src/client/worker/runtime/options.ts), except the four options sdk/CLAUDE.md rule 4
 * pins, which clamp instead (`sdk-clamps.ts`).
 *
 * A duration or count that reached a timer, a loop bound or a lease as NaN, a negative
 * number, Infinity or a fraction could become a 1 ms timer, a hot loop or a command
 * that never ran. Those values are rejected where they enter, with a TypeError (not a
 * number) or a RangeError (out of range) naming the owner and the option. Every value
 * 0.2.2 handled without such a failure keeps 0.2.2's result (`legacy-coercion.ts`): a
 * numeric string is its number, a negative `maxInFlight` is unbounded, a pool size is
 * floored. `undefined` and `null` keep the documented defaults. Long durations stay
 * valid: the timers are armed through `timing.ts`, which honours any delay.
 */

import type { ConnectionOptions } from './connection-types.js';
import { legacyDelay, numericString } from './legacy-coercion.js';
import { clampBatchSize, clampPollTimeout, heartbeatSeconds } from './sdk-clamps.js';
import { assertDuration, assertInteger, describeValue } from './timing.js';
import type { WorkerOptions } from './worker-types.js';

/** Connections per pool: the TCP connections one address can hold to one broker. */
export const MAX_POOL_SIZE = 65_535;

type ConnectionTimingOptions = Pick<
  ConnectionOptions,
  'connectTimeoutMs' | 'commandTimeoutMs' | 'maxInFlight'
>;

export interface ConnectionTimings {
  connectTimeoutMs: number;
  commandTimeoutMs: number;
  /** 0 or Infinity: unbounded. */
  maxInFlight: number;
}

export interface ResolvedWorkerOptions {
  concurrency: number;
  batchSize: number;
  pollTimeoutMs: number;
  lockTtlMs: number;
  /** Seconds; 0 means heartbeats are disabled. */
  heartbeatIntervalS: number;
  /** Present only when ACK batching is enabled. */
  ackBatch: { maxSize: number; maxDelayMs: number } | null;
}

/** `undefined` and `null` both mean "use the default". */
export function isSet<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

/**
 * A numeric string is its number in each option (0.2.2's timers and comparisons read
 * it so).
 *
 * - `connectTimeoutMs` (default 5000): finite, >= 1.
 * - `commandTimeoutMs` (default 10000): >= 1, or Infinity for no client-side deadline.
 * - `maxInFlight` (default 0): any number but NaN (which parked every command forever);
 *   0, a negative number or -Infinity means unbounded, as in 0.2.2, and a fraction or
 *   a huge value gates as 0.2.2 compared it (2.5 admits a third command).
 */
export function resolveConnectionTimings(
  owner: string,
  options: ConnectionTimingOptions | null | undefined
): ConnectionTimings {
  const connectTimeoutMs = numericString(options?.connectTimeoutMs ?? 5000);
  const commandTimeoutMs = numericString(options?.commandTimeoutMs ?? 10_000);
  return {
    connectTimeoutMs: assertDuration(connectTimeoutMs, `${owner}: connectTimeoutMs`, { min: 1 }),
    commandTimeoutMs: assertDuration(commandTimeoutMs, `${owner}: commandTimeoutMs`, {
      min: 1,
      allowInfinity: true,
    }),
    maxInFlight: resolveMaxInFlight(`${owner}: maxInFlight`, options?.maxInFlight ?? 0),
  };
}

function resolveMaxInFlight(name: string, value: unknown): number {
  const limit = numericString(value);
  if (typeof limit !== 'number' || limit !== limit) {
    const ErrorType = typeof limit === 'number' ? RangeError : TypeError;
    throw new ErrorType(
      `${name} must be a number of commands, 0 or below for unbounded (got ${describeValue(value)})`
    );
  }
  return limit > 0 ? limit : 0;
}

/** A per-call timeout of `Connection.call()`: >= 1 ms or Infinity; omitted = default. */
export function commandDeadline(timeoutMs: number | null | undefined, fallback: number): number {
  if (!isSet(timeoutMs)) return fallback;
  return assertDuration(numericString(timeoutMs), 'Connection: call() timeoutMs', {
    min: 1,
    allowInfinity: true,
  });
}

/**
 * A pool size, floored as 0.2.2 did (`Math.max(1, Math.floor(size))`): below 1, `null`
 * and -Infinity mean one connection. NaN, `undefined` (0.2.2 built a pool with no
 * connection), Infinity (0.2.2 threw `Invalid array length`) and more than
 * MAX_POOL_SIZE connections to one address throw.
 */
export function resolvePoolSize(name: string, value: unknown): number {
  if (value === null) return 1;
  const size = numericString(value);
  const whole = typeof size === 'number' ? Math.floor(size) : Number.NaN;
  if (whole <= MAX_POOL_SIZE) return Math.max(1, whole);
  const ErrorType = typeof size === 'number' ? RangeError : TypeError;
  throw new ErrorType(
    `${name} must be a number of connections up to ${MAX_POOL_SIZE} (got ${describeValue(value)})`
  );
}

/**
 * Worker options (a numeric string is its number unless noted):
 *
 * - `concurrency` (default 4): a whole number >= 1. Below 1 throws with 0.2.2's
 *   message, `concurrency must be >= 1`.
 * - `lockTtlMs` (default 30000): the lease TTL, finite and >= 1 (0 is expired at grant).
 * - `ackBatch.maxSize` (default 50): compared as 0.2.2 compared it; 0 or below sends
 *   every ACK at once. `ackBatch.maxDelayMs` (default 5): a one-shot delay
 *   (`legacyDelay`); NaN or negative flushes on the next tick, Infinity throws.
 * - SDK clamps (`sdk-clamps.ts`): `batchSize` (default 10) clamps to [1, 1000];
 *   `pollTimeoutMs` (default 5000) clamps to [0, 30000]; a non-finite value of either
 *   means its default, and a non-number batchSize means 10. `heartbeatIntervalS`
 *   (default 10): 0, negative, non-finite or a non-number disables heartbeats.
 */
export function resolveWorkerOptions(opts: WorkerOptions): ResolvedWorkerOptions {
  const ack = opts.ackBatch;
  return {
    concurrency: resolveConcurrency(opts.concurrency ?? 4),
    batchSize: clampBatchSize(opts.batchSize ?? 10),
    pollTimeoutMs: clampPollTimeout(opts.pollTimeoutMs ?? 5000),
    lockTtlMs: assertDuration(numericString(opts.lockTtlMs ?? 30_000), 'Worker: lockTtlMs', {
      min: 1,
    }),
    heartbeatIntervalS: heartbeatSeconds(opts.heartbeatIntervalS ?? 10),
    ackBatch: ack?.enabled
      ? {
          maxSize: ack.maxSize ?? 50,
          maxDelayMs: legacyDelay(ack.maxDelayMs ?? 5, 'Worker: ackBatch.maxDelayMs'),
        }
      : null,
  };
}

function resolveConcurrency(value: unknown): number {
  const concurrency = numericString(value);
  if (typeof concurrency === 'number' && concurrency < 1) {
    throw new RangeError(`Worker: concurrency must be >= 1 (got ${describeValue(value)})`);
  }
  return assertInteger(concurrency, 'Worker: concurrency', { min: 1 });
}
