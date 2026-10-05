/**
 * Repro: S3 backup settings were not validated.
 *
 * - CRITICAL: `backup.retention: NaN` in the config file passed `validateConfig`
 *   (`NaN < 1` is false) and the prune ran `backups.slice(Math.max(NaN, 1))`, which is
 *   `slice(0)`: every backup was deleted, the one just uploaded included.
 * - `backup.interval: NaN` passed validation too and `setInterval(NaN)` uploaded
 *   back-to-back; a valid 30-day interval overflowed the native timer and did the same.
 * - The env path hid typos: `S3_BACKUP_RETENTION=abc` or `0` became 7,
 *   `S3_BACKUP_INTERVAL=0` became 6 h and `1e12` became 1 ms (then rejected only at
 *   `start()`, which logs and keeps the server running without backups).
 * - The CLI `bunqueue backup` command parsed the same env vars with its own copy.
 *
 * Now an invalid interval or retention is never applied: the resolved config carries it
 * in `configErrors` (naming the key or variable), the scheduler logs it at error level
 * and does not start, and a manual `backup()` refuses to run, so nothing is pruned. The
 * server keeps running, as 2.9.10 did (upgrade compatibility). The values 2.9.10 read
 * as the default (`parseInt(...) || default`: `0`, `abc`) keep the default with a
 * warning, and numeric strings in the file (`'3600000'`) are read as numbers.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { S3Client } from 'bun';
import { resolveBackupConfig } from '../src/config/resolve';
import type { BunqueueConfig } from '../src/config/types';
import { S3BackupManager } from '../src/infrastructure/backup/s3Backup';
import type { S3BackupConfig } from '../src/infrastructure/backup/s3BackupConfig';
import {
  cleanupOldBackups,
  listBackups,
  performBackup,
} from '../src/infrastructure/backup/s3BackupOperations';
import { makeSandbox, outcome, withEnv } from './config-test-support';

const env = withEnv();
afterEach(() => env.restore());

const box = makeSandbox('bunqueue-s3-config-');
afterAll(() => box.cleanup());

const db = box.dataPath;
{
  const sqlite = new Database(db);
  sqlite.run('CREATE TABLE t (id INTEGER)');
  sqlite.run('INSERT INTO t VALUES (1)');
  sqlite.close();
}

/** In-memory S3 double: just enough for publish, list and delete. */
function memoryS3(): S3Client & { keys(): string[] } {
  const objects = new Map<string, Uint8Array>();
  const client = {
    file(key: string) {
      return {
        async write(data: Uint8Array | string) {
          objects.set(key, typeof data === 'string' ? new TextEncoder().encode(data) : data);
        },
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list(options: { prefix?: string }) {
      const contents = [...objects.entries()]
        .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
        .map(([key, value]) => ({ key, size: value.byteLength, lastModified: new Date() }));
      return { contents, isTruncated: false };
    },
    keys: () => [...objects.keys()].filter((key) => key.endsWith('.db')).sort(),
  };
  return client as unknown as S3Client & { keys(): string[] };
}

const CREDS = { bucket: 'bucket', accessKeyId: 'key', secretAccessKey: 'secret' };

function config(overrides: Partial<S3BackupConfig> = {}): S3BackupConfig {
  return {
    enabled: true,
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    bucket: 'bucket',
    intervalMs: 3_600_000,
    retention: 7,
    prefix: 'backups/',
    databasePath: db,
    ...overrides,
  };
}

function resolveFile(backup: Record<string, unknown>) {
  return outcome(() =>
    resolveBackupConfig({ backup: { enabled: true, ...backup } } as BunqueueConfig, db)
  );
}

/** The config resolves (startup continues) and names `text` among its configErrors. */
function carries(result: ReturnType<typeof resolveFile>, text: string): void {
  expect(result).toEqual({
    value: expect.objectContaining({ configErrors: [expect.stringContaining(text)] }),
  });
}

describe('retention (finding 4, CRITICAL)', () => {
  test.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])(
    'backup.retention %p is carried as a configuration error, never applied',
    (retention) => {
      carries(resolveFile({ ...CREDS, retention }), 'backup.retention');
    }
  );

  test("backup.retention '3' (a numeric string) is read as 3", () => {
    expect(resolveFile({ ...CREDS, retention: '3' })).toEqual({
      value: expect.not.objectContaining({ configErrors: expect.anything() }),
    });
    expect(resolveBackupConfig({ backup: { retention: '3' } } as never, db).retention).toBe(3);
  });

  // `2.5` is read as 2, as 2.9.10's parseInt did.
  test.each(['-1', '2.5e1', '1e1'])('S3_BACKUP_RETENTION=%p is carried as an error', (raw) => {
    env.set({ S3_BACKUP_RETENTION: raw });
    carries(
      outcome(() => resolveBackupConfig(null, db)),
      `Invalid S3_BACKUP_RETENTION: ${JSON.stringify(raw)}`
    );
  });

  test.each(['abc', '0'])('S3_BACKUP_RETENTION=%p keeps 7, as 2.9.10 did', (raw) => {
    env.set({ S3_BACKUP_RETENTION: raw });
    const resolved = resolveBackupConfig(null, db);
    expect({ retention: resolved.retention, errors: resolved.configErrors }).toEqual({
      retention: 7,
      errors: undefined,
    });
  });

  test('a manager carrying configuration errors never uploads or prunes', async () => {
    const s3 = memoryS3();
    for (let i = 0; i < 3; i++) await performBackup(config(), s3);
    const before = s3.keys();
    const manager = new S3BackupManager({
      ...config(),
      configErrors: ['Invalid S3_BACKUP_RETENTION: "-1"'],
    });
    (manager as unknown as { client: S3Client }).client = s3;
    const result = await manager.backup();
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('S3_BACKUP_RETENTION'),
    });
    expect(s3.keys()).toEqual(before);
    expect(manager.validate()).toEqual({
      valid: false,
      errors: ['Invalid S3_BACKUP_RETENTION: "-1"'],
    });
  });

  test.each([Number.NaN, 0, -1, 2.5, Number.POSITIVE_INFINITY, '3'])(
    'the prune deletes nothing when retention is %p (defense in depth)',
    async (retention) => {
      const s3 = memoryS3();
      for (let i = 0; i < 3; i++) await performBackup(config(), s3);
      const before = s3.keys();
      expect(before).toHaveLength(3);
      await cleanupOldBackups(config({ retention: retention as number }), s3);
      expect(s3.keys()).toEqual(before);
    }
  );

  test('a backup run with an invalid retention keeps the new backup and every old one', async () => {
    const s3 = memoryS3();
    for (let i = 0; i < 3; i++) await performBackup(config(), s3);
    const manager = new S3BackupManager({ ...config(), retention: Number.NaN });
    (manager as unknown as { client: S3Client }).client = s3;

    const result = await manager.backup();
    expect(result.success).toBe(true);
    const remaining = (await listBackups(config(), s3)).map((item) => item.key);
    expect(remaining).toHaveLength(4);
    expect(remaining).toContain(result.key!);
  });
});

describe('interval (finding 3)', () => {
  test.each([Number.NaN, 0, 1000])('backup.interval %p is carried as an error', (interval) => {
    carries(resolveFile({ ...CREDS, interval }), 'backup.interval');
  });

  test("backup.interval '3600000' (a numeric string) is read as a number", () => {
    expect(resolveBackupConfig({ backup: { interval: '3600000' } } as never, db).intervalMs).toBe(
      3_600_000
    );
  });

  test.each(['1e12', '59999'])('S3_BACKUP_INTERVAL=%p is carried as an error', (raw) => {
    env.set({ S3_BACKUP_INTERVAL: raw });
    carries(
      outcome(() => resolveBackupConfig(null, db)),
      `Invalid S3_BACKUP_INTERVAL: ${JSON.stringify(raw)}`
    );
  });

  test.each(['0', 'abc'])('S3_BACKUP_INTERVAL=%p keeps 6 h, as 2.9.10 did', (raw) => {
    env.set({ S3_BACKUP_INTERVAL: raw });
    const resolved = resolveBackupConfig(null, db);
    expect({ interval: resolved.intervalMs, errors: resolved.configErrors }).toEqual({
      interval: 21_600_000,
      errors: undefined,
    });
  });

  test.each([
    ['NaN (invalid)', Number.NaN],
    ['30 days (valid, above the native timer limit)', 2_592_000_000],
  ])('the scheduler never runs back-to-back backups: %s', async (_label, intervalMs) => {
    const manager = new S3BackupManager(config({ intervalMs }));
    let calls = 0;
    manager.backup = async () => {
      calls++;
      return { success: true };
    };
    manager.start();
    await Bun.sleep(300);
    manager.stop();
    expect(calls).toBe(0);
  });
});

describe('one validated source for the server and the CLI (coordinator item 3)', () => {
  test('the CLI factory carries the same invalid env as the server', () => {
    env.set({ S3_BACKUP_RETENTION: '-1' });
    const fromEnv = S3BackupManager.fromEnv(db);
    expect(fromEnv).toEqual(resolveBackupConfig(null, db));
    expect(new S3BackupManager(fromEnv).validate()).toEqual({
      valid: false,
      errors: [expect.stringContaining('Invalid S3_BACKUP_RETENTION: "-1"')],
    });
  });

  test('the CLI factory and the server resolver agree on a valid env', () => {
    env.set({
      S3_BACKUP_ENABLED: 'true',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
      S3_BACKUP_INTERVAL: '3600000',
      S3_BACKUP_RETENTION: '30',
      S3_BACKUP_PREFIX: 'prod/',
    });
    const fromCli = S3BackupManager.fromEnv(db);
    expect(fromCli).toEqual(resolveBackupConfig(null, db));
    expect(fromCli).toMatchObject({ intervalMs: 3_600_000, retention: 30, prefix: 'prod/' });
  });
});
