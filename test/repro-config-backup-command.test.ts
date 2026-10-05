/**
 * Repro: `bunqueue backup` read only env vars. A server configured through
 * bunqueue.config.ts (storage.dataPath, the backup section) could not be backed up or
 * restored from the CLI: the command reported "BUNQUEUE_DATA_PATH not set", or backed
 * up with env values the server never used. `--config` / `-c` were not accepted.
 *
 * The command must now load the same config file as the server (`--config`/`-c`, else
 * bunqueue.config.{ts,js,mjs} in the working directory) with the same precedence
 * (file > env > default) and the same validation.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { executeBackupCommand } from '../src/cli/commands/backup';
import { makeSandbox, REPO, runChild, withEnv } from './config-test-support';

const env = withEnv();
afterEach(() => env.restore());

const box = makeSandbox('bunqueue-backup-cli-');
afterAll(() => box.cleanup());

const CLEAR = {
  BUNQUEUE_DATA_PATH: undefined,
  BQ_DATA_PATH: undefined,
  DATA_PATH: undefined,
  SQLITE_PATH: undefined,
  S3_BUCKET: undefined,
  AWS_BUCKET: undefined,
  S3_ACCESS_KEY_ID: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  S3_SECRET_ACCESS_KEY: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  S3_BACKUP_RETENTION: undefined,
  S3_BACKUP_INTERVAL: undefined,
};

const FILE_CONFIG = `export default {
  storage: { dataPath: ${JSON.stringify(join(box.dir, 'file.db'))} },
  backup: {
    bucket: 'file-bucket',
    accessKeyId: 'file-key',
    secretAccessKey: 'file-secret',
    retention: 30,
    interval: 3600000,
  },
};
`;
const configPath = box.writeFile('production.config.ts', FILE_CONFIG);
const invalidPath = box.writeFile(
  'invalid.config.ts',
  "export default { storage: { dataPath: '/tmp/x.db' }, backup: { retention: 0 } };\n"
);

describe('explicit --config', () => {
  test.each([
    [['status', '--config', configPath]],
    [['status', `--config=${configPath}`]],
    [['status', '-c', configPath]],
  ])('%j reads the data path and backup settings from the file', async (args) => {
    env.set(CLEAR);
    const result = await executeBackupCommand(args);
    expect(result).toEqual({
      success: true,
      message: 'Backup configuration',
      data: {
        enabled: false,
        bucket: 'file-bucket',
        endpoint: 'AWS S3',
        interval: '60 minutes',
        retention: '30 backups',
      },
    });
  });

  test('the file wins over env vars, which still fill what it leaves unset', async () => {
    env.set({ ...CLEAR, S3_BUCKET: 'env-bucket', S3_REGION: 'eu-west-1' });
    const result = await executeBackupCommand(['status', '--config', configPath]);
    expect(result).toMatchObject({ success: true, data: { bucket: 'file-bucket' } });
  });

  test('an invalid file value is rejected with the key name', async () => {
    env.set(CLEAR);
    await expect(executeBackupCommand(['status', '--config', invalidPath])).rejects.toThrow(
      'backup.retention must be a finite number >= 1 (got 0)'
    );
  });

  test('a missing file is an error, not a silent fallback to env', async () => {
    env.set(CLEAR);
    await expect(
      executeBackupCommand(['status', '--config', join(box.dir, 'missing.ts')])
    ).rejects.toThrow(`Config file not found: ${join(box.dir, 'missing.ts')}`);
  });

  test('--config needs a value', async () => {
    env.set(CLEAR);
    await expect(executeBackupCommand(['status', '--config'])).rejects.toThrow(
      'Invalid --config: missing value'
    );
  });
});

test('auto-discovers bunqueue.config.ts in the working directory, like the server', async () => {
  const dir = makeSandbox('bunqueue-backup-discovery-');
  try {
    dir.writeFile('bunqueue.config.ts', FILE_CONFIG);
    const run = await runChild([join(REPO, 'src/cli/index.ts'), 'backup', 'status', '--json'], {
      cwd: dir.dir,
      killAfterMs: 10_000,
    });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.output)).toMatchObject({
      success: true,
      data: { bucket: 'file-bucket', retention: '30 backups' },
    });
  } finally {
    dir.cleanup();
  }
}, 15_000);

test('without a file or env data path, the existing message is kept', async () => {
  env.set(CLEAR);
  const result = await executeBackupCommand(['status']);
  expect(result.success).toBe(false);
  expect(result.message).toContain('DATA_PATH not set');
  expect(result.message).toContain('storage.dataPath');
});
