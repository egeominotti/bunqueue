import type { ConnectionOptions, WorkerOptions } from '../../types';
import { assertGroupPullOptions } from '../../../domain/types/group';
import { assertDuration, assertInteger, describeValue } from '../../../shared/durations';
import { rejectLegacyConnectionOptions } from '../../legacyConnectionOptions';
import { resolveToken } from '../../resolveToken';
import { coerceNumericString, isFiniteNumber } from '../../tcp/numeric';
import { TcpConnectionPool } from '../../tcpPool';
import { WORKER_CONSTANTS } from '../constants';
import type { ExtendedWorkerOptions } from '../types';

type WorkerDurations = Pick<
  ExtendedWorkerOptions,
  'heartbeatInterval' | 'pollTimeout' | 'drainDelay' | 'lockDuration'
>;

/**
 * Validate the duration options before anything is armed or sent, so a typo throws
 * here, naming the option, instead of becoming a hot loop or a broken lease. A numeric
 * string ("1000") is that number, as 2.9.10's comparisons and timers read it
 * (`tcp/numeric.ts`).
 *
 * - `heartbeatInterval` (default 10000): 0 disables both heartbeats, and so does a
 *   negative value or NaN, as 2.9.10's `heartbeatInterval > 0` guard read them; any
 *   other value is finite and >= 1, as in SandboxedWorker (a positive period below
 *   1 ms ticks about every millisecond and floods the broker). Values above the native
 *   timer limit are honoured by `safeInterval`.
 * - `pollTimeout` (default 0): >= 0; a negative value or NaN means 0 (no long-poll), as
 *   2.9.10's `pollTimeout > 0` guard read them; values above 30000, Infinity included,
 *   are clamped to 30000, the documented maximum of the PULL long-poll.
 * - `drainDelay` (default 50): finite, >= 1, checked only without a long-poll, the only
 *   mode that reads it (`pollTimeout > 0 ? 10 : drainDelay`). It re-arms the
 *   empty-queue pull loop, so 0 would re-poll continuously (the same ~870 pulls/s as
 *   NaN); 1 ms is the timer resolution.
 * - `lockDuration` (default 30000): finite, >= 1, checked only with `useLocks` (it is
 *   the lease TTL, unused without locks). The lease expires at `now + lockDuration`, so
 *   0 or less is already expired when granted and NaN or Infinity never expires. There
 *   is no timer, so any length up to the broker's `lockTtl` bound
 *   (`Number.MAX_SAFE_INTEGER`) is accepted.
 */
function resolveDurations(options: WorkerOptions): WorkerDurations {
  const pollTimeout = disabledUnlessPositive(options.pollTimeout, 0, (value) =>
    assertDuration(value, 'Worker: pollTimeout', { allowInfinity: true })
  );
  const drainDelay = coerceNumericString(options.drainDelay ?? 50);
  const lockDuration = coerceNumericString(options.lockDuration ?? 30_000);
  return {
    heartbeatInterval: disabledUnlessPositive(options.heartbeatInterval, 10_000, (value) =>
      assertDuration(value, 'Worker: heartbeatInterval', { min: 1 })
    ),
    pollTimeout: Math.min(pollTimeout, WORKER_CONSTANTS.MAX_POLL_TIMEOUT),
    drainDelay:
      pollTimeout > 0
        ? unusedNumber(drainDelay, 50)
        : assertDuration(drainDelay, 'Worker: drainDelay', { min: 1 }),
    // Read only by a lock-based pull (`if (config.useLocks)`), so the same truthiness.
    lockDuration: !(options.useLocks ?? true)
      ? unusedNumber(lockDuration, 30_000)
      : assertDuration(lockDuration, 'Worker: lockDuration', {
          min: 1,
          max: Number.MAX_SAFE_INTEGER, // the broker's lockTtl bound (domain/job/options.ts)
        }),
  };
}

/**
 * A duration 2.9.10 used only when `> 0`: 0, a negative number and NaN mean 0
 * (disabled); anything else goes through `validate`. `undefined`/`null` mean `fallback`.
 */
function disabledUnlessPositive(
  raw: unknown,
  fallback: number,
  validate: (value: unknown) => number
): number {
  const value = coerceNumericString(raw ?? fallback);
  if (typeof value === 'number' && !(value > 0)) return 0;
  return validate(value);
}

/** An option the active mode never reads: kept when it is a number, else the default. */
function unusedNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

/**
 * Worker `concurrency`: a number > 0 or Infinity. 2.9.10 gated starts with
 * `active >= concurrency`, so a fraction ran the next whole number of jobs (2.5 ran 3)
 * and Infinity ran every pulled job; it is normalized to that. 0, a negative value and
 * NaN never started a job, so they throw. A numeric string is that number.
 */
export function resolveWorkerConcurrency(raw: unknown, name: string): number {
  const value = coerceNumericString(raw);
  if (value === Infinity) return value;
  if (isFiniteNumber(value) && value > 0) return Math.ceil(value);
  const message = `${name} must be a number > 0 or Infinity (got ${describeValue(value)})`;
  throw typeof value === 'number' ? new RangeError(message) : new TypeError(message);
}

/**
 * Worker `batchSize`: a number >= 1 or Infinity (clamped to 1000 by the caller). A
 * fraction rounds up, as 2.9.10's pull read it (`jobs.length < count`: 2.5 pulled 3);
 * 0, a negative value or NaN never pulled, so they throw.
 */
function resolveBatchSize(raw: unknown): number {
  const value = coerceNumericString(raw);
  if (isFiniteNumber(value) && value > 0) return Math.ceil(value);
  return assertInteger(value, 'Worker: batchSize', { min: 1, allowInfinity: true });
}

export function resolveWorkerOptions(
  options: WorkerOptions,
  embedded: boolean
): ExtendedWorkerOptions {
  rejectLegacyConnectionOptions('Worker', options, embedded);
  assertGroupPullOptions(options.group);
  const durations = resolveDurations(options);
  // It gates starts and sizes the TCP pool (min(concurrency, 8)).
  const concurrency = resolveWorkerConcurrency(options.concurrency ?? 1, 'Worker: concurrency');
  const batch = options.batch;
  // Unused under a native `batch`, whose size is the pull size. Values above the
  // documented maximum of 1000, Infinity included, are clamped below.
  const batchSize = batch ? batch.size : resolveBatchSize(options.batchSize ?? 10);
  if (batch) {
    if (!Number.isSafeInteger(batch.size) || batch.size <= 0 || batch.size > 1000) {
      throw new Error('batch.size must be a positive safe integer no greater than 1000');
    }
    const minSize = batch.minSize ?? 1;
    if (!Number.isSafeInteger(minSize) || minSize <= 0 || minSize > batch.size) {
      throw new Error('batch.minSize must be between 1 and batch.size');
    }
    if (options.limiter && !options.limiter.groupKey && minSize > options.limiter.max) {
      throw new Error('batch.minSize cannot exceed limiter.max');
    }
    if (
      batch.timeout !== undefined &&
      (!Number.isSafeInteger(batch.timeout) || batch.timeout < 0)
    ) {
      throw new Error('batch.timeout must be a non-negative safe integer');
    }
  }
  return {
    concurrency,
    autorun: options.autorun ?? true,
    heartbeatInterval: durations.heartbeatInterval,
    batchSize: Math.min(batchSize, 1000),
    pollTimeout: durations.pollTimeout,
    embedded,
    useLocks: options.useLocks ?? true,
    skipLockRenewal: options.skipLockRenewal ?? false,
    skipStalledCheck: options.skipStalledCheck ?? false,
    drainDelay: durations.drainDelay,
    lockDuration: durations.lockDuration,
    maxStalledCount: options.maxStalledCount ?? 1,
    removeOnComplete: options.removeOnComplete,
    removeOnFail: options.removeOnFail,
    connection: options.connection,
    group: options.group,
    batch: batch
      ? {
          size: batch.size,
          minSize: batch.minSize ?? 1,
          timeout: batch.timeout ?? 0,
          groupAffinity: batch.groupAffinity ?? false,
        }
      : undefined,
  };
}

export function createTcpPool(options: WorkerOptions, concurrency: number): TcpConnectionPool {
  const connection: ConnectionOptions = options.connection ?? {};
  const poolSize = connection.poolSize ?? Math.min(concurrency, 8);
  const token = resolveToken(connection.token);
  return new TcpConnectionPool({
    host: connection.host ?? 'localhost',
    port: connection.port ?? 6789,
    token,
    tls: connection.tls,
    poolSize,
    pingInterval: connection.pingInterval,
    commandTimeout: connection.commandTimeout,
    maxCommandTimeouts: connection.maxCommandTimeouts,
    pipelining: connection.pipelining,
    maxInFlight: connection.maxInFlight,
  });
}
