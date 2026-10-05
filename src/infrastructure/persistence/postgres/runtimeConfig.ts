import { hostname } from 'node:os';
import { assertDuration } from '../../../shared/durations';
import { POSTGRES_MAX_SESSION_TIMEOUT_MS } from './sessionLimits';
import type { PostgresStorageConfig } from './types';

/**
 * The longest lease or poll interval: the largest whole number of milliseconds a
 * JavaScript number represents exactly. Both feed deadline arithmetic and the runtime
 * timers, which honour any such value (`src/shared/timers.ts`).
 */
const POSTGRES_MAX_INTERVAL_MS = Number.MAX_SAFE_INTEGER;

function integerAtLeast(value: number | undefined, fallback: number, minimum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value!));
}

/**
 * A duration setting: a non-finite value uses the default, a value below `minimum` is
 * raised to it (the documented runtime minimum) and fractions are floored, as before;
 * a value above `maximum` is rejected with a RangeError that names the setting.
 */
function durationAtLeast(
  name: string,
  value: number | undefined,
  defaults: { readonly fallback: number; readonly minimum: number; readonly maximum: number }
): number {
  const resolved = integerAtLeast(value, defaults.fallback, defaults.minimum);
  if (resolved > defaults.maximum) {
    throw new RangeError(
      `PostgreSQL storage ${name} must be at most ${defaults.maximum} ms (got ${String(value)})`
    );
  }
  return resolved;
}

/**
 * A PostgreSQL session timeout, with the server configuration's rule
 * (`src/config/settings.ts`): unset uses the default; otherwise a finite number of
 * milliseconds from 1 to 2147483647 (fractions floored), or a RangeError that names the
 * setting. Raising a smaller value to 1 ms, as before, failed nearly every statement;
 * PostgreSQL's own `0` = disabled is deliberately not offered.
 */
function sessionTimeout(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const valid = assertDuration(value, `PostgreSQL storage ${name}`, {
    min: 1,
    max: POSTGRES_MAX_SESSION_TIMEOUT_MS,
  });
  return Math.floor(valid);
}

export function resolvePostgresRuntimeConfig(config: PostgresStorageConfig) {
  const url = new URL(config.url);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('PostgreSQL storage requires a postgres:// or postgresql:// URL');
  }
  if (
    config.maxQueueEvents !== undefined &&
    Number.isFinite(config.maxQueueEvents) &&
    config.maxQueueEvents < 1
  ) {
    throw new Error('PostgreSQL storage requires maxQueueEvents to be at least 1');
  }
  const poolSize = integerAtLeast(config.poolSize, 4, 2);
  const maxConcurrentOperations = integerAtLeast(config.maxConcurrentOperations, 16, 1);
  return {
    url: config.url,
    namespace: config.namespace?.trim() || 'default',
    brokerId:
      config.brokerId?.trim() || `${hostname()}:${process.pid}:${Bun.randomUUIDv7().slice(-12)}`,
    brokerSessionId: Bun.randomUUIDv7(),
    poolSize,
    leaseDurationMs: durationAtLeast('leaseDurationMs', config.leaseDurationMs, {
      fallback: 30_000,
      minimum: 1000,
      maximum: POSTGRES_MAX_INTERVAL_MS,
    }),
    pollIntervalMs: durationAtLeast('pollIntervalMs', config.pollIntervalMs, {
      fallback: 250,
      minimum: 25,
      maximum: POSTGRES_MAX_INTERVAL_MS,
    }),
    statementTimeoutMs: sessionTimeout('statementTimeoutMs', config.statementTimeoutMs, 30_000),
    lockTimeoutMs: sessionTimeout('lockTimeoutMs', config.lockTimeoutMs, 5_000),
    idleTransactionTimeoutMs: sessionTimeout(
      'idleTransactionTimeoutMs',
      config.idleTransactionTimeoutMs,
      30_000
    ),
    maxConcurrentOperations,
    maxQueuedOperations: integerAtLeast(config.maxQueuedOperations, 128, 0),
    maxSnapshotJobs: integerAtLeast(config.maxSnapshotJobs, 100_000, 1),
    maxSnapshotPayloadBytes: integerAtLeast(config.maxSnapshotPayloadBytes, 256 * 1024 * 1024, 1),
    maxQueueEvents: integerAtLeast(config.maxQueueEvents, 10_000, 1),
    maxMetricDataPoints: integerAtLeast(config.maxMetricDataPoints, 20_160, 0),
    maxCompletedJobs: integerAtLeast(config.maxCompletedJobs, 50_000, 1),
    maxJobResults: integerAtLeast(config.maxJobResults, 10_000, 0),
  };
}
