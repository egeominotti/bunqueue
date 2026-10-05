/**
 * Repro: text env vars were compared with one spelling and anything else was silently
 * read as the other value.
 *
 * - `S3_BACKUP_ENABLED=yes` (or `on`, `TRUE`) meant false: no backups, no error.
 * - `METRICS_AUTH=1` (or `yes`, `TRUE`) meant false: /prometheus stayed unauthenticated.
 * - `BUNQUEUE_CLOUD_REMOTE_COMMANDS=0` (or `no`, `off`) meant TRUE: only the exact word
 *   `false` turned remote control of the instance off. `BUNQUEUE_CLOUD_INCLUDE_JOB_DATA=no`
 *   kept sending job payloads; the same held for USE_WEBSOCKET and USE_HTTP.
 * - `S3_VIRTUAL_HOSTED_STYLE=yes` meant false.
 * - An unknown `LOG_LEVEL` was ignored, `LOG_FORMAT=JSON` kept text logs, and the config
 *   file accepted only lowercase `logging.level`/`logging.format` while the env var was
 *   case-insensitive.
 * - S3 backup enabled without a bucket or credentials started the server anyway; the
 *   scheduler only logged "configuration invalid" and never ran.
 *
 * Booleans now accept 1/0, true/false, yes/no, on/off in any case, and the log settings
 * accept their values in any case, from the env and the file alike. For upgrade
 * compatibility (2.9.10 ran with them), any other boolean word keeps the value 2.9.10
 * gave it with a warning naming the variable, log aliases map to a level (`warning`,
 * `verbose`) and an unknown log word is a warning, and an enabled backup without its
 * required settings keeps the server running: the backup carries the problems
 * (`configErrors`, logged at error level) and never runs.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { resolveBackupConfig, resolveCloudConfig, resolveServerConfig } from '../src/config';
import type { BunqueueConfig } from '../src/config';
import { outcome, withEnv } from './config-test-support';

const env = withEnv();
afterEach(() => env.restore());

const BOOLEAN_EXPECTED = '(expected one of 1, 0, true, false, yes, no, on, off)';
const CLOUD = {
  BUNQUEUE_CLOUD_URL: 'https://cloud.example',
  BUNQUEUE_CLOUD_API_KEY: 'key',
  BUNQUEUE_CLOUD_INSTANCE_ID: 'instance-1',
};
const S3 = { S3_BUCKET: 'bucket', S3_ACCESS_KEY_ID: 'key', S3_SECRET_ACCESS_KEY: 'secret' };

function server(vars: Record<string, string | undefined>, file: unknown = null) {
  env.set(vars);
  return outcome(() => resolveServerConfig(file as BunqueueConfig | null));
}

describe('boolean env vars', () => {
  test.each([
    ['yes', true],
    ['on', true],
    ['TRUE', true],
    [' 1 ', true],
    ['No', false],
    ['off', false],
    ['0', false],
    ['false', false],
  ])('S3_BACKUP_ENABLED=%p is %p', (raw, enabled) => {
    expect(server({ ...S3, S3_BACKUP_ENABLED: raw })).toEqual({
      value: expect.objectContaining({ s3BackupEnabled: enabled }),
    });
  });

  test.each([
    ['1', true],
    ['yes', true],
    ['TRUE', true],
    ['off', false],
  ])('METRICS_AUTH=%p is %p', (raw, required) => {
    expect(server({ METRICS_AUTH: raw })).toEqual({
      value: expect.objectContaining({ requireAuthForMetrics: required }),
    });
  });

  test.each([
    ['S3_BACKUP_ENABLED', false],
    ['METRICS_AUTH', false],
    ['S3_VIRTUAL_HOSTED_STYLE', false],
    ['BUNQUEUE_CLOUD_INCLUDE_JOB_DATA', true],
    ['BUNQUEUE_CLOUD_USE_WEBSOCKET', true],
    ['BUNQUEUE_CLOUD_USE_HTTP', true],
    ['BUNQUEUE_CLOUD_REMOTE_COMMANDS', true],
  ])('%s keeps its 2.9.10 value for an unknown word, with a warning', (name, value) => {
    expect(server({ [name]: 'maybe' })).toEqual({
      value: expect.objectContaining({
        configWarnings: [
          `Invalid ${name}: "maybe" ${BOOLEAN_EXPECTED.slice(0, -1)}); using ${value}`,
        ],
      }),
    });
  });

  test('an empty value means unset', () => {
    expect(server({ METRICS_AUTH: '', S3_BACKUP_ENABLED: '' })).toEqual({
      value: expect.objectContaining({ requireAuthForMetrics: false, s3BackupEnabled: false }),
    });
  });

  test('Cloud switches honour every spelling of "off" (remote control included)', () => {
    env.set({
      ...CLOUD,
      BUNQUEUE_CLOUD_REMOTE_COMMANDS: '0',
      BUNQUEUE_CLOUD_INCLUDE_JOB_DATA: 'no',
      BUNQUEUE_CLOUD_USE_WEBSOCKET: 'OFF',
      BUNQUEUE_CLOUD_USE_HTTP: 'False',
    });
    expect(resolveCloudConfig(null)).toMatchObject({
      remoteCommands: false,
      includeJobData: false,
      useWebSocket: false,
      useHttp: false,
    });
  });

  test('S3_VIRTUAL_HOSTED_STYLE: yes is true, unset leaves the provider default', () => {
    env.set({ S3_VIRTUAL_HOSTED_STYLE: 'yes' });
    expect(resolveBackupConfig(null, '/tmp/q.db').virtualHostedStyle).toBe(true);
    env.set({ S3_VIRTUAL_HOSTED_STYLE: undefined });
    expect(resolveBackupConfig(null, '/tmp/q.db').virtualHostedStyle).toBeUndefined();
  });
});

describe('logging', () => {
  const LEVELS = '(expected one of debug, info, warn, error)';
  const FORMATS = '(expected one of text, json)';

  test.each([
    [{ LOG_LEVEL: 'loud' }, `Invalid LOG_LEVEL: "loud" ${LEVELS.slice(0, -1)}); ignored`],
    [{ LOG_FORMAT: 'xml' }, `Invalid LOG_FORMAT: "xml" ${FORMATS.slice(0, -1)}); using text`],
  ])('%j is a warning listing the accepted values', (vars, message) => {
    expect(server(vars)).toEqual({
      value: expect.objectContaining({ configWarnings: [message] }),
    });
  });

  test.each([
    ['verbose', 'debug'],
    ['warning', 'warn'],
  ])('LOG_LEVEL=%p is an alias of %p', (raw, level) => {
    expect(server({ LOG_LEVEL: raw })).toEqual({
      value: expect.objectContaining({ logLevel: level }),
    });
  });

  test('env and file accept any case and agree (file > env > default)', () => {
    expect(server({ LOG_LEVEL: 'DEBUG', LOG_FORMAT: 'JSON' })).toEqual({
      value: expect.objectContaining({ logLevel: 'debug', logFormat: 'json' }),
    });
    expect(
      server(
        { LOG_LEVEL: undefined, LOG_FORMAT: undefined },
        { logging: { level: 'WARN', format: 'Text' } }
      )
    ).toEqual({
      value: expect.objectContaining({ logLevel: 'warn', logFormat: 'text' }),
    });
    expect(server({ LOG_LEVEL: 'debug' }, { logging: { level: 'error' } })).toEqual({
      value: expect.objectContaining({ logLevel: 'error' }),
    });
    expect(server({ LOG_LEVEL: undefined, LOG_FORMAT: undefined })).toEqual({
      value: expect.objectContaining({ logLevel: 'info', logFormat: 'text' }),
    });
  });

  test('an unknown file value is a warning listing the accepted values', () => {
    expect(server({}, { logging: { level: 'loud' } })).toEqual({
      value: expect.objectContaining({
        logLevel: undefined,
        configWarnings: [
          'logging.level must be one of debug, info, warn, error (got "loud"); ignored',
        ],
      }),
    });
  });
});

describe('S3 backup enabled without its required settings (item 5)', () => {
  const MISSING = {
    bucket: 'bucket (backup.bucket, S3_BUCKET or AWS_BUCKET)',
    key: 'access key ID (backup.accessKeyId, S3_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID)',
    secret:
      'secret access key (backup.secretAccessKey, S3_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY)',
  };
  const missing = (...labels: string[]) => [
    `S3 backup required settings are missing: ${labels.join(', ')}`,
  ];

  /** Server startup succeeds; the backup carries the problems instead. */
  function backup(vars: Record<string, string | undefined>, file: unknown = null) {
    expect(server(vars, file)).toEqual({
      value: expect.objectContaining({ s3BackupEnabled: true }),
    });
    return resolveBackupConfig(file as BunqueueConfig | null, '/tmp/q.db').configErrors;
  }

  test('from the env: every missing setting is named', () => {
    expect(backup({ S3_BACKUP_ENABLED: 'true' })).toEqual(
      missing(MISSING.bucket, MISSING.key, MISSING.secret)
    );
  });

  test('from the file, with the AWS aliases filling part of it', () => {
    expect(
      backup({ AWS_ACCESS_KEY_ID: 'aws-key' }, { backup: { enabled: true, bucket: 'b' } })
    ).toEqual(missing(MISSING.secret));
  });

  test('empty strings count as missing; complete settings have no problems', () => {
    expect(backup({ ...S3, S3_BUCKET: '', S3_BACKUP_ENABLED: '1' })).toEqual(
      missing(MISSING.bucket)
    );
    expect(backup({ ...S3, S3_BACKUP_ENABLED: '1' })).toBeUndefined();
    expect(server({ S3_BACKUP_ENABLED: '0' })).toEqual({
      value: expect.objectContaining({ s3BackupEnabled: false }),
    });
  });
});
