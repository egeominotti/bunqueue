/**
 * Repro: the config file was never validated (`loadConfigFile` returns whatever the
 * module exports and `defineConfig` returns its argument), so every value reached the
 * server raw:
 *
 * - `timeouts.stats: 0` armed a ~1 ms stats interval; `timeouts.shutdown: NaN` skipped
 *   the graceful drain;
 * - `storage.completedRetentionMs: NaN` or `'5000'` silently disabled retention;
 * - `auth.tokens: 'secret'` became `new Set('secret')`: every single character of the
 *   string was accepted as an auth token;
 * - `backup.enabled: 'false'` is a truthy string and enabled backups;
 * - `timeouts.worker`, `timeouts.lock` and `webhooks.*` were accepted and ignored.
 *
 * Values the server cannot use must now stop startup with the key name; unknown keys
 * stay accepted (forward compatibility) but are reported as warnings. For upgrade
 * compatibility (see test/repro-compat-config-file.test.ts), what 2.9.10 used or ignored
 * is not an error: numeric strings for ports, timeouts and backup settings are read as
 * numbers; documented fallbacks (retention off, the default count) are kept with a
 * warning; a boolean given as a string keeps its truthiness (`'false'` is true), with a
 * warning; a comma-separated `cors.origins` string
 * is split; log aliases map to a level; `timeouts.worker`, `timeouts.lock` and
 * `webhooks.*` stay ignored with a warning; a backup problem disables the backup (with
 * an error log), not the server.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { resolveServerConfig } from '../src/config/resolve';
import type { BunqueueConfig } from '../src/config/types';
import { outcome, withEnv } from './config-test-support';

const env = withEnv();
afterEach(() => env.restore());

function resolveFile(file: unknown) {
  return outcome(() => resolveServerConfig(file as BunqueueConfig));
}

function rejectedKey(key: string): { error: string } {
  return { error: expect.stringContaining(key) };
}

describe('numeric keys (findings 1, 2, 7, 8, 11)', () => {
  test.each([
    ['timeouts.stats', { timeouts: { stats: 0 } }],
    ['timeouts.stats', { timeouts: { stats: Number.NaN } }],
    ['timeouts.stats', { timeouts: { stats: 'often' } }],
    ['timeouts.shutdown', { timeouts: { shutdown: Number.NaN } }],
    ['timeouts.shutdown', { timeouts: { shutdown: -1 } }],
    ['timeouts.shutdown', { timeouts: { shutdown: Number.POSITIVE_INFINITY } }],
    [
      'storage.statementTimeoutMs',
      { storage: { driver: 'postgres', statementTimeoutMs: 2 ** 31 } },
    ],
    ['server.tcpPort', { server: { tcpPort: '' } }],
    ['server.httpPort', { server: { httpPort: 70_000 } }],
  ])('rejects an invalid %s', (key, file) => {
    expect(resolveFile(file)).toEqual(rejectedKey(key));
  });

  test.each([
    ['storage.completedRetentionMs', { storage: { completedRetentionMs: Number.NaN } }],
    ['storage.completedRetentionMs', { storage: { completedRetentionMs: -1 } }],
    ['storage.completedRetentionMs', { storage: { completedRetentionMs: '5000' } }],
    ['storage.maxCompletedJobs', { storage: { maxCompletedJobs: 0 } }],
    ['storage.pollIntervalMs', { storage: { pollIntervalMs: Number.NaN } }],
    ['storage.poolSize', { storage: { poolSize: 0.5 } }],
    ['telemetry.maxPrometheusQueues', { telemetry: { maxPrometheusQueues: -1 } }],
  ])('keeps the 2.9.10 fallback of an invalid %s, with a warning', (key, file) => {
    expect(resolveFile(file)).toEqual({
      value: expect.objectContaining({ configWarnings: [expect.stringContaining(key)] }),
    });
  });

  test('keeps valid values, null retention, numeric strings and the rounding of fractions', () => {
    const result = resolveFile({
      server: { tcpPort: 0, httpPort: '0' },
      storage: { completedRetentionMs: 12.9, maxCompletedJobs: 321 },
      timeouts: { shutdown: 0, stats: '2592000000' },
      telemetry: { maxPrometheusQueues: 0 },
    });
    expect(result).toEqual({
      value: expect.objectContaining({
        tcpPort: 0,
        httpPort: 0,
        completedRetentionMs: 12,
        maxCompletedJobs: 321,
        shutdownTimeoutMs: 0,
        statsIntervalMs: 2_592_000_000,
        maxPrometheusQueues: 0,
        configWarnings: [],
      }),
    });
    expect(resolveFile({ storage: { completedRetentionMs: null } })).toEqual({
      value: expect.objectContaining({ completedRetentionMs: null }),
    });
  });
});

describe('wrong types (finding 12)', () => {
  test('auth.tokens given as a string is rejected instead of splitting into characters', () => {
    const result = resolveFile({ auth: { tokens: 'secret' } });
    if ('value' in result) {
      // Show what the server would have accepted as tokens.
      expect([...new Set(result.value.authTokens)]).toEqual(['secret']);
    }
    expect(result).toEqual(rejectedKey('auth.tokens'));
  });

  test.each([
    ['cors.origins', { cors: { origins: 42 } }],
    ['server.host', { server: { host: 6789 } }],
    ['storage.driver', { storage: { driver: 'mysql' } }],
    ['cloud.url', { cloud: { url: 42 } }],
    ['storage', { storage: 'sqlite' }],
  ])('rejects a wrongly typed %s', (key, file) => {
    expect(resolveFile(file)).toEqual(rejectedKey(key));
  });

  test('a non-boolean keeps its 2.9.10 truthiness with a warning; a cors string is split', () => {
    expect(
      resolveFile({
        backup: { enabled: 'false' },
        auth: { tokens: ['t'], requireAuthForMetrics: ['true'] },
        cors: { origins: 'https://a.example' },
      })
    ).toEqual({
      value: expect.objectContaining({
        s3BackupEnabled: true,
        requireAuthForMetrics: true,
        corsOrigins: ['https://a.example'],
        configWarnings: expect.arrayContaining([
          expect.stringContaining('backup.enabled'),
          expect.stringContaining('auth.requireAuthForMetrics'),
        ]),
      }),
    });
  });

  test.each([
    ['logging.level', { logging: { level: 'loud' } }],
    ['logging.format', { logging: { format: 'yaml' } }],
    ['backup.retention', { backup: { retention: Number.NaN } }],
    ['backup.interval', { backup: { interval: 1000 } }],
  ])('an unusable %s is a warning (2.9.10 ignored it; the backup is disabled)', (key, file) => {
    expect(resolveFile(file)).toEqual({
      value: expect.objectContaining({ configWarnings: [expect.stringContaining(key)] }),
    });
  });

  test('rejects a config module that does not export an object', () => {
    expect(resolveFile(() => ({}))).toEqual({ error: expect.stringContaining('object') });
  });
});

describe('keys documented as ignored stay ignored', () => {
  test('timeouts.worker and timeouts.lock leave WORKER_TIMEOUT_MS / LOCK_TIMEOUT_MS', () => {
    env.set({ WORKER_TIMEOUT_MS: '60000', LOCK_TIMEOUT_MS: '60000' });
    expect(resolveFile({ timeouts: { worker: 30_000, lock: 2_000 } })).toEqual({
      value: expect.objectContaining({ workerTimeoutMs: 60_000, lockTimeoutMs: 60_000 }),
    });
  });

  test('webhooks.maxRetries and webhooks.retryDelay leave the env (env > default)', () => {
    env.set({ WEBHOOK_MAX_RETRIES: '7', WEBHOOK_RETRY_DELAY_MS: '250' });
    expect(resolveFile({ webhooks: { maxRetries: 5, retryDelay: 40 } })).toEqual({
      value: expect.objectContaining({ webhookMaxRetries: 7, webhookRetryDelayMs: 250 }),
    });
    env.set({ WEBHOOK_MAX_RETRIES: undefined, WEBHOOK_RETRY_DELAY_MS: undefined });
    expect(resolveFile(null)).toEqual({
      value: expect.objectContaining({ webhookMaxRetries: 3, webhookRetryDelayMs: 1000 }),
    });
  });

  test('an invalid WEBHOOK_* env var is reported, whatever the file says', () => {
    // The webhook manager reads the env var when it is created.
    env.set({ WEBHOOK_MAX_RETRIES: 'abc' });
    expect(resolveFile({ webhooks: { maxRetries: 5 } })).toEqual({
      error: 'Invalid WEBHOOK_MAX_RETRIES: "abc" (expected a whole number >= 1)',
    });
    expect(resolveFile(null)).toEqual({
      error: 'Invalid WEBHOOK_MAX_RETRIES: "abc" (expected a whole number >= 1)',
    });
  });
});

describe('unknown keys', () => {
  test('are reported as warnings, not errors (forward compatibility)', () => {
    const result = resolveFile({
      storage: { completedRetentionMS: 5000 },
      experimental: { turbo: true },
    });
    expect(result).toEqual({
      value: expect.objectContaining({
        completedRetentionMs: null,
        configWarnings: [
          expect.stringContaining('storage.completedRetentionMS'),
          expect.stringContaining('experimental'),
        ],
      }),
    });
  });
});

test('reports every invalid key at once', () => {
  const result = resolveFile({ timeouts: { stats: 0, shutdown: -1 }, server: { tcpPort: '' } });
  for (const key of ['timeouts.stats', 'timeouts.shutdown', 'server.tcpPort']) {
    expect(result).toEqual(rejectedKey(key));
  }
});
