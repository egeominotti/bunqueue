/**
 * Repro (upgrade compatibility, config file): `bunqueue.config.ts` values that 2.9.10
 * used, or ignored, stopped the 2.9.11 candidate from starting or changed meaning.
 *
 * - Numeric strings (`tcpPort: process.env.PORT`, string timeouts, backup interval and
 *   retention) worked: Bun.listen, setInterval and the comparisons coerce them.
 * - `cors.origins: '*'` worked (`new Set('*')`); `[process.env.X!]` with X unset meant
 *   no CORS origin.
 * - `null` meant unset (`??`): `host: null`, `bucket: process.env.S3_BUCKET ?? null`,
 *   `cloud: null`, `server: null`.
 * - Documented fallbacks: completedRetentionMs -1 / NaN / Infinity / 1e20 meant no
 *   retention; maxPrometheusQueues -1 / NaN, poolSize NaN, maxCompletedJobs 0 meant the
 *   default; a numeric string for those keys was ignored the same way.
 * - Booleans as strings: `backup.enabled: process.env.S3_BACKUP_ENABLED` worked, by
 *   truthiness (`'false'` meant true); that stays, with a warning
 *   (test/repro-compat-config-review.test.ts).
 * - `timeouts.worker`, `timeouts.lock` and `webhooks.*` were documented as ignored; the
 *   candidate applied them (a `lock: 5` meant as seconds became a 5 ms lock wait).
 * - Invalid values of a disabled backup never mattered; `timeouts.stats: 500` worked.
 * - `auth.tokens: [process.env.X!]` with X unset stays fatal, with a message naming the
 *   entry.
 */

import { describe, expect, test } from 'bun:test';
import {
  resolveBackupConfig,
  resolveServerConfig,
  type ResolvedConfig,
} from '../src/config/resolve';
import type { Command } from '../src/domain/types/command';
import { handleCommand } from '../src/infrastructure/server/handler';
import { outcome } from './config-test-support';

type Env = Record<string, string | undefined>;
const CREDS = { bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' };

function resolveFile(file: unknown, env: Env = {}) {
  return outcome(() => resolveServerConfig(file as never, env));
}

function resolved(file: unknown, env: Env = {}): ResolvedConfig {
  const result = resolveFile(file, env);
  if ('error' in result) throw new Error(`unexpected startup error: ${result.error}`);
  return result.value;
}

function warned(config: ResolvedConfig, key: string): boolean {
  return config.configWarnings.some((warning) => warning.includes(key));
}

describe('numeric strings', () => {
  test('ports and timeouts accept a numeric string', () => {
    const config = resolved({
      server: { tcpPort: '41000', httpPort: ' 41001 ' },
      timeouts: { shutdown: '60000', stats: '60000' },
    });
    expect(config).toMatchObject({
      tcpPort: 41_000,
      httpPort: 41_001,
      shutdownTimeoutMs: 60_000,
      statsIntervalMs: 60_000,
    });
  });

  test('backup interval and retention accept a numeric string', () => {
    const file = { backup: { enabled: true, ...CREDS, interval: '3600000', retention: '30' } };
    expect(resolveBackupConfig(file as never, '/tmp/x.db', {})).toMatchObject({
      intervalMs: 3_600_000,
      retention: 30,
    });
  });

  test("'' and NaN ports stay errors (2.9.10 bound a random port or threw)", () => {
    expect(resolveFile({ server: { tcpPort: '' } })).toEqual({
      error: expect.stringContaining('server.tcpPort'),
    });
    expect(resolveFile({ server: { tcpPort: Number.NaN } })).toEqual({
      error: expect.stringContaining('server.tcpPort'),
    });
  });
});

describe('cors.origins', () => {
  test('a string is split on commas like CORS_ALLOW_ORIGIN', () => {
    expect(resolved({ cors: { origins: '*' } }).corsOrigins).toEqual(['*']);
    expect(
      resolved({ cors: { origins: 'https://a.example,https://b.example' } }).corsOrigins
    ).toEqual(['https://a.example', 'https://b.example']);
  });

  test('undefined, null and empty entries are dropped with a warning', () => {
    const config = resolved({ cors: { origins: [undefined, null, '', 'https://a.example'] } });
    expect(config.corsOrigins).toEqual(['https://a.example']);
    expect(warned(config, 'cors.origins')).toBe(true);
    expect(resolved({ cors: { origins: [undefined] } }).corsOrigins).toEqual([]);
  });
});

describe('null means unset', () => {
  test.each([{ server: null }, { cloud: null }, { backup: null }, { auth: null }])(
    'section %p is absent',
    (file) => {
      expect('value' in resolveFile(file)).toBe(true);
    }
  );

  test('null keys fall back to the env and defaults', () => {
    const config = resolved(
      { server: { host: null, tcpPort: null }, backup: { enabled: false, bucket: null } },
      { HOST: '127.0.0.1', TCP_PORT: '41002' }
    );
    expect(config).toMatchObject({ hostname: '127.0.0.1', tcpPort: 41_002 });
  });
});

describe('documented fallbacks warn and keep the 2.9.10 value', () => {
  test.each([-1, Number.POSITIVE_INFINITY, Number.NaN, 1e20, '3600000'])(
    'completedRetentionMs %p means no retention',
    (value) => {
      const config = resolved({ storage: { completedRetentionMs: value } });
      expect(config.completedRetentionMs).toBeNull();
      expect(warned(config, 'storage.completedRetentionMs')).toBe(true);
    }
  );

  test.each([
    [{ telemetry: { maxPrometheusQueues: -1 } }, 'maxPrometheusQueues', 100],
    [{ telemetry: { maxPrometheusQueues: Number.NaN } }, 'maxPrometheusQueues', 100],
    [{ storage: { poolSize: Number.NaN } }, 'postgresPoolSize', 4],
    [{ storage: { maxCompletedJobs: 0 } }, 'maxCompletedJobs', 50_000],
    [{ storage: { maxCompletedJobs: Number.NaN } }, 'maxCompletedJobs', 50_000],
    [{ storage: { maxCompletedJobs: '100000' } }, 'maxCompletedJobs', 50_000],
    [{ storage: { maxQueuedOperations: -1 } }, 'postgresMaxQueuedOperations', 128],
    [{ storage: { statementTimeoutMs: 0 } }, 'postgresStatementTimeoutMs', 30_000],
  ] as const)('%p resolves %s = %p with a warning', (file, key, value) => {
    const config = resolved(file);
    expect(config[key]).toBe(value);
    expect(config.configWarnings.length).toBeGreaterThan(0);
  });
});

describe('booleans as strings keep their 2.9.10 truthiness', () => {
  test.each([
    ['true', true],
    ['1', true],
    ['false', true],
    ['', false],
  ])('backup.enabled %p is %p', (raw, enabled) => {
    const file = { storage: { dataPath: '/tmp/x.db' }, backup: { enabled: raw, ...CREDS } };
    expect(resolved(file).s3BackupEnabled).toBe(enabled);
  });
});

describe('keys 2.9.10 documented as ignored stay ignored', () => {
  test('timeouts.worker, timeouts.lock and webhooks.* warn and leave the env values', () => {
    const env = {
      WORKER_TIMEOUT_MS: '60000',
      LOCK_TIMEOUT_MS: '7000',
      WEBHOOK_MAX_RETRIES: '4',
      WEBHOOK_RETRY_DELAY_MS: '250',
    };
    const file = {
      timeouts: { worker: 5, lock: 0 },
      webhooks: { maxRetries: 0, retryDelay: Number.NaN },
    };
    const config = resolved(file, env);
    expect(config).toMatchObject({
      workerTimeoutMs: 60_000,
      lockTimeoutMs: 7000,
      webhookMaxRetries: 4,
      webhookRetryDelayMs: 250,
    });
    for (const [key, envName] of [
      ['timeouts.worker', 'WORKER_TIMEOUT_MS'],
      ['timeouts.lock', 'LOCK_TIMEOUT_MS'],
      ['webhooks.maxRetries', 'WEBHOOK_MAX_RETRIES'],
      ['webhooks.retryDelay', 'WEBHOOK_RETRY_DELAY_MS'],
    ]) {
      expect(config.configWarnings.some((w) => w.includes(key) && w.includes(envName))).toBe(true);
    }
  });
});

describe('disabled features, logging words and the stats period', () => {
  test('invalid values of a disabled backup are warnings', () => {
    const config = resolved({ backup: { enabled: false, retention: 0, interval: Number.NaN } });
    expect(warned(config, 'backup.retention')).toBe(true);
    expect(warned(config, 'backup.interval')).toBe(true);
  });

  test("logging 'warning' / 'verbose' / 'pretty' and timeouts.stats 500", () => {
    expect(resolved({ logging: { level: 'warning' } }).logLevel).toBe('warn');
    expect(resolved({ logging: { level: 'verbose' } }).logLevel).toBe('debug');
    const pretty = resolved({ logging: { format: 'pretty' } });
    expect(pretty.logFormat).toBe('text');
    expect(warned(pretty, 'logging.format')).toBe(true);
    expect(resolved({ timeouts: { stats: 500 } }).statsIntervalMs).toBe(500);
  });

  test('an enabled backup without credentials or with a short interval does not stop startup', () => {
    const file = {
      storage: { dataPath: '/tmp/x.db' },
      backup: { enabled: true, interval: 30_000 },
    };
    expect(resolved(file).s3BackupEnabled).toBe(true);
    const backup = resolveBackupConfig(file as never, '/tmp/x.db', {});
    expect(backup.configErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('backup.bucket'),
        expect.stringContaining('backup.interval'),
      ])
    );
  });
});

describe('auth tokens', () => {
  test('[process.env.X!] with X unset stays fatal and names the entry', () => {
    expect(resolveFile({ auth: { tokens: [undefined] } })).toEqual({
      error: expect.stringContaining('auth.tokens[0] must be a non-empty string (got undefined)'),
    });
  });

  test('configured tokens are trimmed like AUTH_TOKENS', () => {
    expect(resolved({ auth: { tokens: ['s3cret\n'] } }).authTokens).toEqual(['s3cret']);
  });

  test('the Auth command compares both sides trimmed and never accepts a blank token', async () => {
    const auth = async (token: unknown, configured: string) => {
      const ctx = {
        queueManager: { emitDashboardEvent() {} },
        authTokens: new Set([configured]),
        authenticated: false,
      };
      const response = await handleCommand({ cmd: 'Auth', token } as Command, ctx as never);
      return response.ok === true && ctx.authenticated;
    };
    expect(await auth('s3cret\n', 's3cret')).toBe(true);
    expect(await auth(' s3cret ', 's3cret\n')).toBe(true);
    expect(await auth('s3cret', 's3cret')).toBe(true);
    expect(await auth('other', 's3cret')).toBe(false);
    expect(await auth('', 's3cret')).toBe(false);
    expect(await auth(' \n', 's3cret')).toBe(false);
    expect(await auth(42, 's3cret')).toBe(false);
  });
});
