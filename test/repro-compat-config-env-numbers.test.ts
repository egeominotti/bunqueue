/**
 * Repro (upgrade compatibility, numeric env vars): values that 2.9.10 read the way the
 * operator meant, or tolerated explicitly, stopped the 2.9.11 candidate from starting.
 *
 * - Grammar: 2.9.10 read every numeric env var with `parseInt`, so `+6789`, `6789.0`,
 *   `5000ms`, `512MB` and Docker `--env-file` lines such as `60000 # 1 minute` were
 *   read as written. The candidate accepted bare digits only. Values `parseInt` misread
 *   (`30s` -> 30, `1e3` -> 1, `6789abc`) must still be refused.
 * - `-1` meaning "off": 2.9.10 clamped TCP_IDLE_TIMEOUT_MS / TCP_MAX_WRITE_QUEUE_BYTES
 *   with `Math.max(0, ...)`, skipped every monitoring check whose threshold is `<= 0`
 *   and turned a negative completed-job retention into "no retention".
 * - Explicit 2.9.10 fallbacks (`positiveInteger`, `nonNegativeInteger`, `|| 0`): an
 *   unreadable or out-of-range value meant the default. Now a warning plus that value.
 * - STATS_INTERVAL_MS=500 worked; RATE_LIMIT_WINDOW_MS=0 disabled rate limiting;
 *   RATE_LIMIT_CLEANUP_MS=0 only skipped the idle sweep.
 * - An empty primary variable shadowed its legacy alias (`??`): an empty
 *   BUNQUEUE_MAX_COMPLETED_JOBS meant 50000 even with MAX_COMPLETED_JOBS=1000.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readMonitoringThresholds } from '../src/config/componentEnv';
import { resolveServerConfig, type ResolvedConfig } from '../src/config/resolve';
import { parseDurationEnv, parseIntegerEnv } from '../src/shared/durations';
import { ProtocolRateLimiter } from '../src/infrastructure/server/rateLimiter';
import { outcome, REPO } from './config-test-support';

type Env = Record<string, string | undefined>;

function resolveEnv(env: Env): ReturnType<typeof outcome<ResolvedConfig>> {
  return outcome(() => resolveServerConfig(null, env));
}

/** The resolved config, failing the test with the error when resolution throws. */
function resolved(env: Env): ResolvedConfig {
  const result = resolveEnv(env);
  if ('error' in result) throw new Error(`unexpected startup error: ${result.error}`);
  return result.value;
}

function warningsAbout(config: ResolvedConfig, name: string): string[] {
  return config.configWarnings.filter((warning) => warning.includes(name));
}

describe('grammar 2.9.10 read as written (parseInt)', () => {
  test.each([
    [{ TCP_PORT: '+6789' }, 'tcpPort', 6789],
    [{ TCP_PORT: '6789.0' }, 'tcpPort', 6789],
    [{ HTTP_PORT: ' 6790.00 ' }, 'httpPort', 6790],
    [{ STATS_INTERVAL_MS: '60000 # 1 minute' }, 'statsIntervalMs', 60_000],
    [{ SHUTDOWN_TIMEOUT_MS: '5000ms' }, 'shutdownTimeoutMs', 5000],
    [{ SHUTDOWN_TIMEOUT_MS: '5000 MS' }, 'shutdownTimeoutMs', 5000],
    [{ BUNQUEUE_MAX_COMPLETED_JOBS: '+1000' }, 'maxCompletedJobs', 1000],
    [{ BUNQUEUE_COMPLETED_RETENTION_MS: '3600000ms' }, 'completedRetentionMs', 3_600_000],
  ] as const)('%p resolves %s = %p', (env, key, value) => {
    expect(resolveEnv(env)).toEqual({ value: expect.objectContaining({ [key]: value }) });
  });

  test('megabyte thresholds accept an mb/MB suffix', () => {
    expect(
      outcome(() =>
        readMonitoringThresholds({ MEMORY_WARNING_MB: '512mb', STORAGE_WARNING_MB: '1024MB' })
      )
    ).toEqual({
      value: expect.objectContaining({ memoryWarningMb: 512, storageWarningMb: 1024 }),
    });
  });

  test('the shared parser accepts the same forms', () => {
    expect(parseIntegerEnv('X', '+5', 0)).toBe(5);
    expect(parseIntegerEnv('X', '5.000', 0)).toBe(5);
    expect(parseIntegerEnv('X', '5 # five', 0)).toBe(5);
    expect(parseDurationEnv('X', '250ms', 0)).toBe(250);
  });

  test('tolerances keep a value with a warning; numberSyntax reads like Number()', () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    expect(parseIntegerEnv('X', '-1', 9, { negative: 0, warn })).toBe(0);
    expect(parseIntegerEnv('X', 'abc', 9, { min: 1, invalid: 4, warn })).toBe(4);
    expect(parseIntegerEnv('X', '0', 9, { min: 1, invalid: 4, warn })).toBe(4);
    expect(warnings).toEqual([
      'Invalid X: "-1" (expected a whole number >= 0); using 0',
      'Invalid X: "abc" (expected a whole number >= 1); using 4',
      'Invalid X: "0" (expected a whole number >= 1); using 4',
    ]);
    // A misread is never tolerated.
    expect(() => parseIntegerEnv('X', '30s', 9, { invalid: 4, warn })).toThrow('Invalid X: "30s"');
    expect(parseIntegerEnv('X', '1e3', 9, { numberSyntax: true })).toBe(1000);
    expect(parseIntegerEnv('X', '0x10', 9, { numberSyntax: true })).toBe(16);
    expect(() => parseIntegerEnv('X', '5ms', 9, { numberSyntax: true })).toThrow('Invalid X');
  });

  test.each([
    ['STATS_INTERVAL_MS', '30s'],
    ['STATS_INTERVAL_MS', '5m'],
    ['STATS_INTERVAL_MS', '1e3'],
    ['SHUTDOWN_TIMEOUT_MS', '5000mb'],
    ['TCP_PORT', '6789abc'],
    ['TCP_PORT', '"6789"'],
    ['BUNQUEUE_MAX_COMPLETED_JOBS', '1e5'],
  ])('still refuses %s=%p (2.9.10 misread or could not bind it)', (name, raw) => {
    expect(resolveEnv({ [name]: raw })).toEqual({
      error: expect.stringContaining(`Invalid ${name}: ${JSON.stringify(raw)}`),
    });
  });
});

describe('explicit 2.9.10 fallbacks become a warning plus the same value', () => {
  test.each([
    [{ BUNQUEUE_MAX_COMPLETED_JOBS: '"1000"' }, 'maxCompletedJobs', 50_000],
    [{ BUNQUEUE_MAX_COMPLETED_JOBS: '0' }, 'maxCompletedJobs', 50_000],
    [{ METRICS_MAX_QUEUES: '-1' }, 'maxPrometheusQueues', 100],
    [{ METRICS_MAX_QUEUES: 'abc' }, 'maxPrometheusQueues', 100],
    [{ BUNQUEUE_COMPLETED_RETENTION_MS: '-1' }, 'completedRetentionMs', null],
    [{ BUNQUEUE_COMPLETED_RETENTION_MS: 'abc' }, 'completedRetentionMs', null],
  ] as const)('%p resolves %s = %p with a warning', (env, key, value) => {
    const config = resolved(env);
    expect(config[key]).toBe(value);
    expect(warningsAbout(config, Object.keys(env)[0]).length).toBe(1);
  });

  test('PostgreSQL counts fall back on a PostgreSQL server; misreads still stop it', () => {
    const postgres = { BUNQUEUE_POSTGRES_URL: 'postgres://u@localhost/db' };
    const config = resolved({ ...postgres, BUNQUEUE_POSTGRES_POOL_SIZE: 'abc' });
    expect(config.postgresPoolSize).toBe(4);
    expect(warningsAbout(config, 'BUNQUEUE_POSTGRES_POOL_SIZE').length).toBe(1);
    expect(resolved({ ...postgres, BUNQUEUE_POSTGRES_MAX_QUEUED_OPERATIONS: '-1' })).toMatchObject({
      postgresMaxQueuedOperations: 128,
    });
    expect(resolveEnv({ ...postgres, BUNQUEUE_POSTGRES_POLL_INTERVAL_MS: '1e3' })).toEqual({
      error: expect.stringContaining('Invalid BUNQUEUE_POSTGRES_POLL_INTERVAL_MS: "1e3"'),
    });
  });
});

describe('-1 means "off" where 2.9.10 clamped or skipped it', () => {
  test('TCP idle timeout and write-queue cap start with a warning', () => {
    const config = resolved({ TCP_IDLE_TIMEOUT_MS: '-1', TCP_MAX_WRITE_QUEUE_BYTES: '-1' });
    expect(warningsAbout(config, 'TCP_IDLE_TIMEOUT_MS').length).toBe(1);
    expect(warningsAbout(config, 'TCP_MAX_WRITE_QUEUE_BYTES').length).toBe(1);
  });

  test('monitoring thresholds read abc as 0 (2.9.10 never fired a NaN check)', () => {
    expect(outcome(() => readMonitoringThresholds({ QUEUE_IDLE_THRESHOLD_MS: 'abc' }))).toEqual({
      value: expect.objectContaining({ queueIdleMs: 0 }),
    });
    expect(outcome(() => readMonitoringThresholds({ QUEUE_IDLE_THRESHOLD_MS: '30s' }))).toEqual({
      error: expect.stringContaining('Invalid QUEUE_IDLE_THRESHOLD_MS: "30s"'),
    });
  });

  test('monitoring thresholds read -1 as 0 (disabled)', () => {
    const env = {
      QUEUE_IDLE_THRESHOLD_MS: '-1',
      QUEUE_SIZE_THRESHOLD: '-1',
      WORKER_OVERLOAD_THRESHOLD_MS: '-1',
      MEMORY_WARNING_MB: '-1',
      STORAGE_WARNING_MB: '-1',
    };
    expect(outcome(() => readMonitoringThresholds(env))).toEqual({
      value: {
        queueIdleMs: 0,
        queueSize: 0,
        workerOverloadMs: 0,
        memoryWarningMb: 0,
        storageWarningMb: 0,
      },
    });
    expect('value' in resolveEnv(env)).toBe(true);
  });
});

describe('values that 2.9.10 honoured', () => {
  test('STATS_INTERVAL_MS=500 is accepted; 0 (a 1 ms loop) is still refused', () => {
    expect(resolved({ STATS_INTERVAL_MS: '500' }).statsIntervalMs).toBe(500);
    expect(resolveEnv({ STATS_INTERVAL_MS: '0' })).toEqual({
      error: expect.stringContaining('Invalid STATS_INTERVAL_MS: "0"'),
    });
  });

  test('RATE_LIMIT_WINDOW_MS=0 disables rate limiting', () => {
    expect('value' in resolveEnv({ RATE_LIMIT_WINDOW_MS: '0' })).toBe(true);
    const limiter = new ProtocolRateLimiter({ windowMs: 0, maxRequests: 2, cleanupIntervalMs: 0 });
    const allowed = Array.from({ length: 50 }, () => limiter.isAllowed('client')).filter(Boolean);
    limiter.stop();
    expect(allowed.length).toBe(50);
  });

  test('RATE_LIMIT_WINDOW_MS=0 from the env disables the shared limiter', () => {
    const script = `
      const { getRateLimiter, stopRateLimiter } = await import(${JSON.stringify(join(REPO, 'src/infrastructure/server/rateLimiter.ts'))});
      const limiter = getRateLimiter();
      let allowed = 0;
      for (let i = 0; i < 100; i++) if (limiter.isAllowed('c')) allowed++;
      stopRateLimiter();
      console.log(JSON.stringify({ allowed }));`;
    const run = Bun.spawnSync([process.execPath, '-e', script], {
      env: {
        PATH: process.env.PATH ?? '',
        RATE_LIMIT_WINDOW_MS: '0',
        RATE_LIMIT_MAX_REQUESTS: '5',
      },
    });
    expect(run.stdout.toString().trim().split('\n').at(-1)).toBe('{"allowed":100}');
  });

  test('RATE_LIMIT_MAX_REQUESTS without a number disables the limit with a warning', () => {
    // 2.9.10: parseInt gave NaN and `count >= NaN` never blocked a request.
    const config = resolved({ RATE_LIMIT_MAX_REQUESTS: 'abc' });
    expect(warningsAbout(config, 'RATE_LIMIT_MAX_REQUESTS').length).toBe(1);
    const script = `
      const { getRateLimiter, stopRateLimiter } = await import(${JSON.stringify(join(REPO, 'src/infrastructure/server/rateLimiter.ts'))});
      const limiter = getRateLimiter();
      let allowed = 0;
      for (let i = 0; i < 100; i++) if (limiter.isAllowed('c')) allowed++;
      stopRateLimiter();
      console.log(JSON.stringify({ allowed }));`;
    const run = Bun.spawnSync([process.execPath, '-e', script], {
      env: { PATH: process.env.PATH ?? '', RATE_LIMIT_MAX_REQUESTS: 'abc' },
    });
    expect(run.stdout.toString().trim().split('\n').at(-1)).toBe('{"allowed":100}');
    expect(run.stderr.toString() + run.stdout.toString()).toContain(
      'Invalid RATE_LIMIT_MAX_REQUESTS'
    );
    // 0 rejected every request and -1 too, `1e4` was read as 1: still errors.
    for (const raw of ['0', '-1', '1e4']) {
      expect(resolveEnv({ RATE_LIMIT_MAX_REQUESTS: raw })).toEqual({
        error: expect.stringContaining(`Invalid RATE_LIMIT_MAX_REQUESTS: ${JSON.stringify(raw)}`),
      });
    }
  });

  test('WEBHOOK_RETRY_DELAY_MS without a number or negative retries at once, with a warning', () => {
    // 2.9.10: Bun.sleep(NaN) and a negative delay resolved at once.
    for (const raw of ['abc', '-1']) {
      const config = resolved({ WEBHOOK_RETRY_DELAY_MS: raw });
      expect(config.webhookRetryDelayMs).toBe(0);
      expect(warningsAbout(config, 'WEBHOOK_RETRY_DELAY_MS').length).toBe(1);
    }
    expect(resolveEnv({ WEBHOOK_RETRY_DELAY_MS: '1e3' })).toEqual({
      error: expect.stringContaining('Invalid WEBHOOK_RETRY_DELAY_MS: "1e3"'),
    });
  });

  test('RATE_LIMIT_CLEANUP_MS=0 starts with a warning (the default sweep is kept)', () => {
    const config = resolved({ RATE_LIMIT_CLEANUP_MS: '0' });
    expect(warningsAbout(config, 'RATE_LIMIT_CLEANUP_MS').length).toBe(1);
  });
});

describe('an empty primary variable shadows its legacy alias, as with `??`', () => {
  test('empty BUNQUEUE_MAX_COMPLETED_JOBS keeps 50000 even with MAX_COMPLETED_JOBS set', () => {
    expect(
      resolved({ BUNQUEUE_MAX_COMPLETED_JOBS: '', MAX_COMPLETED_JOBS: '1000' }).maxCompletedJobs
    ).toBe(50_000);
    expect(resolved({ MAX_COMPLETED_JOBS: '1000' }).maxCompletedJobs).toBe(1000);
  });

  test('empty BUNQUEUE_COMPLETED_RETENTION_MS keeps retention off', () => {
    expect(
      resolved({ BUNQUEUE_COMPLETED_RETENTION_MS: '', COMPLETED_RETENTION_MS: '3600000' })
        .completedRetentionMs
    ).toBeNull();
    expect(resolved({ BUNQUEUE_COMPLETED_RETENTION_MS: '  ' }).completedRetentionMs).toBeNull();
    expect(resolved({ COMPLETED_RETENTION_MS: '3600000' }).completedRetentionMs).toBe(3_600_000);
  });
});
