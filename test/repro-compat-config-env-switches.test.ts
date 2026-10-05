/**
 * Repro (upgrade compatibility, words and unused settings): env values that 2.9.10
 * ignored, or read with its own rule, stopped the 2.9.11 candidate from starting.
 *
 * - LOG_LEVEL / LOG_FORMAT: 2.9.10 ignored a value it did not know (`WARNING`, `trace`,
 *   `verbose`, `"info"`, `pretty`) and kept info/text. Common aliases now map to a
 *   level; any other word is a warning, never a startup error. When the config file sets
 *   `logging.level`, 2.9.10 never applied LOG_LEVEL, so it must not stop startup either.
 * - Booleans: 2.9.10 compared one spelling (`=== 'true'`, `!== 'false'`), so
 *   `BUNQUEUE_CLOUD_USE_HTTP=enabled` meant true and `METRICS_AUTH="true"` (with quotes)
 *   meant false. An unknown word is now a warning plus that same value.
 * - Unused settings (Cloud numbers without Cloud, BUNQUEUE_CLOUD_INTERVAL_MS, S3_BACKUP_*
 *   with backups off, BUNQUEUE_POSTGRES_* on SQLite) never stopped 2.9.10.
 * - S3 backup enabled without a bucket, or with an interval under a minute: 2.9.10 logged
 *   "S3 backup configuration invalid" and ran without backups; the candidate refused to
 *   start. S3_BACKUP_RETENTION=0 or `abc` meant 7 (`parseInt(...) || 7`).
 */

import { describe, expect, test } from 'bun:test';
import { resolveBackupConfig, resolveCloudConfig } from '../src/config/resolve';
import { resolveServerConfig, type ResolvedConfig } from '../src/config/resolve';
import { outcome } from './config-test-support';

type Env = Record<string, string | undefined>;

const CLOUD: Env = {
  BUNQUEUE_CLOUD_URL: 'https://cloud.example',
  BUNQUEUE_CLOUD_API_KEY: 'key',
  BUNQUEUE_CLOUD_INSTANCE_ID: 'instance',
};
const S3: Env = {
  BUNQUEUE_DATA_PATH: '/tmp/bunqueue-compat.db',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret',
};

function resolved(env: Env, file: unknown = null): ResolvedConfig {
  const result = outcome(() => resolveServerConfig(file as never, env));
  if ('error' in result) throw new Error(`unexpected startup error: ${result.error}`);
  return result.value;
}

function warned(config: ResolvedConfig, name: string): boolean {
  return config.configWarnings.some((warning) => warning.includes(name));
}

describe('LOG_LEVEL and LOG_FORMAT', () => {
  test.each([
    ['WARNING', 'warn'],
    ['warning', 'warn'],
    ['trace', 'debug'],
    ['verbose', 'debug'],
    ['fatal', 'error'],
    ['critical', 'error'],
    ['"info"', 'info'],
    [' DEBUG ', 'debug'],
  ])('LOG_LEVEL=%p resolves to %p', (raw, level) => {
    expect(resolved({ LOG_LEVEL: raw }).logLevel).toBe(level as ResolvedConfig['logLevel']);
  });

  test('object property names are not levels', () => {
    for (const raw of ['constructor', '__proto__', 'toString']) {
      const config = resolved({ LOG_LEVEL: raw });
      expect(config.logLevel).toBeUndefined();
      expect(warned(config, 'LOG_LEVEL')).toBe(true);
    }
  });

  test('an unknown level or format is a warning, not a startup error', () => {
    const config = resolved({ LOG_LEVEL: 'loud', LOG_FORMAT: 'pretty' });
    expect(config.logFormat).toBe('text');
    expect(warned(config, 'LOG_LEVEL')).toBe(true);
    expect(warned(config, 'LOG_FORMAT')).toBe(true);
    expect(resolved({ LOG_FORMAT: 'JSON' }).logFormat).toBe('json');
  });

  test('a file logging.level wins without LOG_LEVEL being validated', () => {
    const file = { logging: { level: 'warn' } };
    expect(resolved({ LOG_LEVEL: 'trace' }, file).logLevel).toBe('warn');
    const config = resolved({ LOG_LEVEL: 'loud' }, file);
    expect(config.logLevel).toBe('warn');
    expect(warned(config, 'LOG_LEVEL')).toBe(false);
  });
});

describe('boolean env vars: unknown words keep the 2.9.10 value with a warning', () => {
  test('METRICS_AUTH ("true" with quotes, "enabled") stays false; TRUE is true', () => {
    for (const raw of ['"true"', 'enabled']) {
      const config = resolved({ METRICS_AUTH: raw });
      expect(config.requireAuthForMetrics).toBe(false);
      expect(warned(config, 'METRICS_AUTH')).toBe(true);
    }
    expect(resolved({ METRICS_AUTH: 'TRUE' }).requireAuthForMetrics).toBe(true);
  });

  test('S3_BACKUP_ENABLED=enabled stays off', () => {
    const config = resolved({ ...S3, S3_BACKUP_ENABLED: 'enabled' });
    expect(config.s3BackupEnabled).toBe(false);
    expect(warned(config, 'S3_BACKUP_ENABLED')).toBe(true);
  });

  test('Cloud switches stay on for an unknown word', () => {
    const env = {
      ...CLOUD,
      BUNQUEUE_CLOUD_USE_HTTP: 'enabled',
      BUNQUEUE_CLOUD_REMOTE_COMMANDS: '"false"',
    };
    expect(warned(resolved(env), 'BUNQUEUE_CLOUD_USE_HTTP')).toBe(true);
    const cloud = outcome(() => resolveCloudConfig(null, undefined, env));
    expect(cloud).toEqual({
      value: expect.objectContaining({ useHttp: true, remoteCommands: true }),
    });
    expect(
      outcome(() => resolveCloudConfig(null, undefined, { ...CLOUD, BUNQUEUE_CLOUD_USE_HTTP: '0' }))
    ).toEqual({ value: expect.objectContaining({ useHttp: false }) });
  });

  test('S3_VIRTUAL_HOSTED_STYLE=enabled is false, as 2.9.10 compared "1"/"true"', () => {
    const env = { ...S3, S3_VIRTUAL_HOSTED_STYLE: 'enabled' };
    expect(outcome(() => resolveBackupConfig(null, '/tmp/x.db', env))).toEqual({
      value: expect.objectContaining({ virtualHostedStyle: false }),
    });
  });
});

describe('settings of features that are off never stop startup', () => {
  test('Cloud numbers without Cloud are warnings', () => {
    const config = resolved({
      BUNQUEUE_CLOUD_BUFFER_SIZE: 'abc',
      BUNQUEUE_CLOUD_CIRCUIT_BREAKER_THRESHOLD: '0',
    });
    expect(warned(config, 'BUNQUEUE_CLOUD_BUFFER_SIZE')).toBe(true);
    expect(warned(config, 'BUNQUEUE_CLOUD_CIRCUIT_BREAKER_THRESHOLD')).toBe(true);
  });

  test('BUNQUEUE_CLOUD_INTERVAL_MS is never applied, so never fatal', () => {
    const env = { ...CLOUD, BUNQUEUE_CLOUD_INTERVAL_MS: '15s' };
    expect(warned(resolved(env), 'BUNQUEUE_CLOUD_INTERVAL_MS')).toBe(true);
    expect('value' in outcome(() => resolveCloudConfig(null, undefined, env))).toBe(true);
  });

  test('S3_BACKUP_* with backups off are warnings', () => {
    const config = resolved({ S3_BACKUP_INTERVAL: '1000', S3_BACKUP_RETENTION: '-1' });
    expect(warned(config, 'S3_BACKUP_INTERVAL')).toBe(true);
    expect(warned(config, 'S3_BACKUP_RETENTION')).toBe(true);
  });

  test('BUNQUEUE_POSTGRES_* on SQLite are warnings', () => {
    const config = resolved({
      BUNQUEUE_DATA_PATH: '/tmp/x.db',
      BUNQUEUE_POSTGRES_LOCK_TIMEOUT_MS: '1e12',
      BUNQUEUE_POSTGRES_POOL_SIZE: 'abc',
    });
    expect(config.storageDriver).toBe('sqlite');
    expect(warned(config, 'BUNQUEUE_POSTGRES_LOCK_TIMEOUT_MS')).toBe(true);
    expect(warned(config, 'BUNQUEUE_POSTGRES_POOL_SIZE')).toBe(true);
  });
});

describe('an enabled S3 backup that cannot run: startup continues without backups', () => {
  test('missing bucket and credentials are reported by the backup, not as a startup error', () => {
    const env = { BUNQUEUE_DATA_PATH: '/tmp/x.db', S3_BACKUP_ENABLED: 'true' };
    expect(resolved(env).s3BackupEnabled).toBe(true);
    const backup = outcome(() => resolveBackupConfig(null, '/tmp/x.db', env));
    expect(backup).toEqual({
      value: expect.objectContaining({ configErrors: [expect.stringContaining('S3_BUCKET')] }),
    });
  });

  test('an interval under a minute or a negative retention is reported, never applied', () => {
    const env = {
      ...S3,
      S3_BACKUP_ENABLED: 'true',
      S3_BACKUP_INTERVAL: '30000',
      S3_BACKUP_RETENTION: '-1',
    };
    expect('value' in outcome(() => resolveServerConfig(null, env))).toBe(true);
    const backup = resolveBackupConfig(null, '/tmp/x.db', env);
    expect(backup.configErrors).toEqual([
      expect.stringContaining('S3_BACKUP_INTERVAL'),
      expect.stringContaining('S3_BACKUP_RETENTION'),
    ]);
  });

  test('S3_BACKUP_RETENTION=0 or abc keeps 7 backups, as `parseInt(...) || 7` did', () => {
    for (const raw of ['0', 'abc']) {
      const env = { ...S3, S3_BACKUP_ENABLED: 'true', S3_BACKUP_RETENTION: raw };
      expect(warned(resolved(env), 'S3_BACKUP_RETENTION')).toBe(true);
      const backup = resolveBackupConfig(null, '/tmp/x.db', env);
      expect({ retention: backup.retention, errors: backup.configErrors ?? [] }).toEqual({
        retention: 7,
        errors: [],
      });
    }
  });
});
