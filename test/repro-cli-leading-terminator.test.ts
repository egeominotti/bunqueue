import { expect, test } from 'bun:test';
import { buildCommand } from '../src/cli/commandRouter';
import { executeBackupCommand } from '../src/cli/commands/backup';
import { parseCliFlags } from '../src/cli/commands/server';
import { CommandError } from '../src/cli/commands/types';
import { parseGlobalOptions } from '../src/cli/globalOptions';
import { S3BackupManager } from '../src/infrastructure/backup';

test('CLI: a trailing terminator preserves explicit server binding options', () => {
  const { commandArgs } = parseGlobalOptions(['start', '--host', '127.0.0.1', '--port', '0', '--']);
  expect(parseCliFlags(commandArgs.slice(1))).toMatchObject({ host: '127.0.0.1', tcpPort: 0 });
});

for (const message of ['--json', '--', '--force']) {
  test(`CLI: a leading terminator preserves the literal log message ${message}`, async () => {
    const { options, commandArgs } = parseGlobalOptions([
      '--',
      'job',
      'log',
      'leading-marker-job',
      message,
    ]);
    expect(options.json).toBe(false);
    expect(await buildCommand(commandArgs[0], commandArgs.slice(1))).toEqual({
      cmd: 'AddLog',
      id: 'leading-marker-job',
      message,
      level: 'info',
    });
  });
}

for (const force of ['--force', '--force=true', '-f', '-f=true']) {
  test(`CLI: a leading terminator cannot authorize restore through literal ${force}`, async () => {
    const validate = S3BackupManager.prototype.validate;
    const restore = S3BackupManager.prototype.restore;
    const dataPath = process.env.BUNQUEUE_DATA_PATH;
    const restored: string[] = [];
    S3BackupManager.prototype.validate = () => ({ valid: true, errors: [] });
    S3BackupManager.prototype.restore = async (key: string) => {
      restored.push(key);
      return { success: true, key, duration: 0 };
    };
    process.env.BUNQUEUE_DATA_PATH = `/tmp/cli-leading-marker-${process.pid}.db`;
    try {
      const { commandArgs } = parseGlobalOptions([
        '--',
        'backup',
        'restore',
        'leading-marker-fixture',
        force,
      ]);
      const result = await executeBackupCommand(commandArgs.slice(1)).catch((error) => {
        expect(error).toBeInstanceOf(CommandError);
        return { success: false };
      });
      expect(result.success).toBe(false);
      expect(restored).toEqual([]);
    } finally {
      S3BackupManager.prototype.validate = validate;
      S3BackupManager.prototype.restore = restore;
      if (dataPath === undefined) delete process.env.BUNQUEUE_DATA_PATH;
      else process.env.BUNQUEUE_DATA_PATH = dataPath;
    }
  });
}
