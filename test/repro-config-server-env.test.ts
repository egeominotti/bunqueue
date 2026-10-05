/**
 * Repro: server env vars were read with a raw `parseInt`, so a typo silently became a
 * different setting instead of stopping startup:
 *
 * - `STATS_INTERVAL_MS=0`, `abc` or `1e12` (parseInt -> 1) armed a ~1 ms stats interval;
 * - `SHUTDOWN_TIMEOUT_MS=abc` (NaN) skipped the graceful drain entirely;
 * - `BUNQUEUE_COMPLETED_RETENTION_MS=1e12` became 1 ms and deleted completed jobs on the
 *   next cleanup tick, while `abc` (NaN) silently turned retention off;
 * - PostgreSQL durations such as `1e12` became 1 (then the runtime floor), and session
 *   timeouts PostgreSQL cannot represent failed only when the pool connected;
 * - ports and counts (`TCP_PORT=6789abc`, `BUNQUEUE_MAX_COMPLETED_JOBS=1e3` -> 1) were
 *   misread, and invalid `METRICS_MAX_QUEUES` silently fell back to the default.
 *
 * Every misread value, and every value the server could not use, must now throw an
 * error naming the variable and the raw value. Values 2.9.10 read as meant (`+6789`,
 * `500` ms stats) start; values it replaced with a documented fallback (`-1`/`abc`
 * retention = off, METRICS_MAX_QUEUES/MAX_COMPLETED_JOBS out of range = the default)
 * keep that fallback with a warning; PostgreSQL settings only stop a PostgreSQL server
 * (upgrade compatibility, see test/repro-compat-config-*.test.ts).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { resolveServerConfig, type ResolvedConfig } from '../src/config/resolve';
import { outcome, withEnv } from './config-test-support';

const env = withEnv();
afterEach(() => env.restore());

function resolveWith(
  vars: Record<string, string | undefined>
): ReturnType<typeof outcome<ResolvedConfig>> {
  env.set(vars);
  return outcome(() => resolveServerConfig(null));
}

function rejected(name: string, raw: string): { error: string } {
  return { error: expect.stringContaining(`Invalid ${name}: ${JSON.stringify(raw)}`) };
}

describe('STATS_INTERVAL_MS (finding 1)', () => {
  test.each(['0', 'abc', '1e12', '-5', '5s', '1.5e3'])('rejects %p', (raw) => {
    const result = resolveWith({ STATS_INTERVAL_MS: raw });
    expect(result).toEqual(rejected('STATS_INTERVAL_MS', raw));
  });

  test('accepts whole milliseconds, including periods above the native timer limit', () => {
    expect(resolveWith({ STATS_INTERVAL_MS: ' 60000 ' })).toEqual({
      value: expect.objectContaining({ statsIntervalMs: 60_000 }),
    });
    expect(resolveWith({ STATS_INTERVAL_MS: '2592000000' })).toEqual({
      value: expect.objectContaining({ statsIntervalMs: 2_592_000_000 }),
    });
    expect(resolveWith({ STATS_INTERVAL_MS: '' })).toEqual({
      value: expect.objectContaining({ statsIntervalMs: 300_000 }),
    });
  });
});

describe('SHUTDOWN_TIMEOUT_MS (finding 2)', () => {
  test.each(['abc', '-1', '1e3', '30s'])('rejects %p', (raw) => {
    expect(resolveWith({ SHUTDOWN_TIMEOUT_MS: raw })).toEqual(rejected('SHUTDOWN_TIMEOUT_MS', raw));
  });

  test('keeps 0 (do not wait for active jobs) and the default', () => {
    expect(resolveWith({ SHUTDOWN_TIMEOUT_MS: '0' })).toEqual({
      value: expect.objectContaining({ shutdownTimeoutMs: 0 }),
    });
    expect(resolveWith({ SHUTDOWN_TIMEOUT_MS: '' })).toEqual({
      value: expect.objectContaining({ shutdownTimeoutMs: 30_000 }),
    });
  });
});

describe('completed-job retention env (finding 7)', () => {
  test.each([
    ['BUNQUEUE_COMPLETED_RETENTION_MS', '1e12'],
    ['BUNQUEUE_COMPLETED_RETENTION_MS', '5s'],
    ['COMPLETED_RETENTION_MS', '1e12'],
  ])('rejects %s=%p', (name, raw) => {
    expect(resolveWith({ BUNQUEUE_COMPLETED_RETENTION_MS: undefined, [name]: raw })).toEqual(
      rejected(name, raw)
    );
  });

  test('keeps the documented meanings: unset disables, 0 expires on the next tick', () => {
    expect(resolveWith({})).toEqual({
      value: expect.objectContaining({ completedRetentionMs: null }),
    });
    expect(resolveWith({ BUNQUEUE_COMPLETED_RETENTION_MS: '0' })).toEqual({
      value: expect.objectContaining({ completedRetentionMs: 0 }),
    });
    expect(
      resolveWith({
        BUNQUEUE_COMPLETED_RETENTION_MS: undefined,
        COMPLETED_RETENTION_MS: '86400000',
      })
    ).toEqual({
      value: expect.objectContaining({ completedRetentionMs: 86_400_000 }),
    });
  });
});

describe('PostgreSQL env settings (finding 8)', () => {
  const POSTGRES = { BUNQUEUE_POSTGRES_URL: 'postgres://user@localhost/db' };

  test.each([
    ['BUNQUEUE_POSTGRES_POLL_INTERVAL_MS', '1e12'],
    ['BUNQUEUE_POSTGRES_LEASE_DURATION_MS', '1e12'],
    ['BUNQUEUE_POSTGRES_STATEMENT_TIMEOUT_MS', '2147483648'],
    ['BUNQUEUE_POSTGRES_MAX_SNAPSHOT_JOBS', '1e5'],
    ['BUNQUEUE_POSTGRES_MAX_SNAPSHOT_PAYLOAD_BYTES', '256MB'],
  ])('a PostgreSQL server rejects %s=%p', (name, raw) => {
    expect(resolveWith({ ...POSTGRES, [name]: raw })).toEqual(rejected(name, raw));
  });

  test.each([
    ['BUNQUEUE_POSTGRES_LOCK_TIMEOUT_MS', 'abc', 'postgresLockTimeoutMs', 5_000],
    [
      'BUNQUEUE_POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS',
      '0',
      'postgresIdleTransactionTimeoutMs',
      30_000,
    ],
    ['BUNQUEUE_POSTGRES_POOL_SIZE', '0', 'postgresPoolSize', 4],
    ['BUNQUEUE_POSTGRES_MAX_CONCURRENT_OPERATIONS', 'x', 'postgresMaxConcurrentOperations', 16],
    ['BUNQUEUE_POSTGRES_MAX_QUEUED_OPERATIONS', '-1', 'postgresMaxQueuedOperations', 128],
  ])('%s=%p keeps the 2.9.10 fallback with a warning', (name, raw, key, fallback) => {
    expect(resolveWith({ ...POSTGRES, [name]: raw })).toEqual({
      value: expect.objectContaining({
        [key]: fallback,
        configWarnings: [expect.stringContaining(`Invalid ${name}: ${JSON.stringify(raw)}`)],
      }),
    });
  });

  test('a server that does not use PostgreSQL only warns', () => {
    const result = resolveWith({ BUNQUEUE_POSTGRES_POLL_INTERVAL_MS: '1e12' });
    expect(result).toEqual({
      value: expect.objectContaining({
        configWarnings: [expect.stringContaining('Invalid BUNQUEUE_POSTGRES_POLL_INTERVAL_MS')],
      }),
    });
  });

  test('keeps names, types and runtime-floor semantics of valid values', () => {
    const result = resolveWith({
      BUNQUEUE_POSTGRES_LEASE_DURATION_MS: '10',
      BUNQUEUE_POSTGRES_POLL_INTERVAL_MS: '2147483648',
      BUNQUEUE_POSTGRES_STATEMENT_TIMEOUT_MS: '2147483647',
      BUNQUEUE_POSTGRES_MAX_QUEUED_OPERATIONS: '0',
    });
    expect(result).toEqual({
      value: expect.objectContaining({
        postgresLeaseDurationMs: 10,
        postgresPollIntervalMs: 2_147_483_648,
        postgresStatementTimeoutMs: 2_147_483_647,
        postgresMaxQueuedOperations: 0,
      }),
    });
  });
});

describe('ports and counts (finding 11)', () => {
  test.each([
    ['TCP_PORT', 'abc'],
    ['TCP_PORT', '70000'],
    ['TCP_PORT', '6789abc'],
    ['HTTP_PORT', '1e4'],
    ['METRICS_MAX_QUEUES', '1e3'],
    ['BUNQUEUE_MAX_COMPLETED_JOBS', '1e3'],
    ['MAX_COMPLETED_JOBS', '10k'],
  ])('rejects %s=%p', (name, raw) => {
    expect(resolveWith({ BUNQUEUE_MAX_COMPLETED_JOBS: undefined, [name]: raw })).toEqual(
      rejected(name, raw)
    );
  });

  test('keeps port 0 (OS-assigned) and 0 per-queue Prometheus series', () => {
    expect(resolveWith({ TCP_PORT: '0', HTTP_PORT: '0', METRICS_MAX_QUEUES: '0' })).toEqual({
      value: expect.objectContaining({ tcpPort: 0, httpPort: 0, maxPrometheusQueues: 0 }),
    });
  });
});

test('reports every invalid variable at once', () => {
  const result = resolveWith({ STATS_INTERVAL_MS: '0', SHUTDOWN_TIMEOUT_MS: 'abc' });
  expect(result).toEqual({ error: expect.stringContaining('STATS_INTERVAL_MS') });
  expect(result).toEqual({ error: expect.stringContaining('SHUTDOWN_TIMEOUT_MS') });
});
