import { expect, test } from 'bun:test';
import { buildCommand } from '../src/cli/commandRouter';
import { executeBackupCommand } from '../src/cli/commands/backup';
import { parseGlobalOptions } from '../src/cli/globalOptions';
import { S3BackupManager } from '../src/infrastructure/backup';
import { runCliRaw } from './cli-invariants/runtimeHarness';

for (const [family, subcommand, target, expected] of [
  ['job', 'get', '--json', { cmd: 'GetJob', id: '--json' }],
  ['queue', 'pause', 'audit-q', { cmd: 'Pause', queue: 'audit-q' }],
  ['cron', 'delete', 'audit-cron', { cmd: 'CronDelete', name: 'audit-cron' }],
  ['worker', 'unregister', 'audit-worker', { cmd: 'UnregisterWorker', workerId: 'audit-worker' }],
  ['webhook', 'remove', 'audit-hook', { cmd: 'RemoveWebhook', webhookId: 'audit-hook' }],
  ['dlq', 'purge', 'audit-q', { cmd: 'PurgeDlq', queue: 'audit-q' }],
  ['rate-limit', 'clear', 'audit-q', { cmd: 'RateLimitClear', queue: 'audit-q' }],
  ['concurrency', 'clear', 'audit-q', { cmd: 'ClearConcurrency', queue: 'audit-q' }],
] as const) {
  test(`CLI: a marker before the ${family} subcommand preserves protected positionals`, async () => {
    const parsed = parseGlobalOptions([family, '--', subcommand, target]);
    expect(await buildCommand(parsed.commandArgs[0], parsed.commandArgs.slice(1))).toMatchObject(
      expected
    );
  });
}

test('CLI: unsupported embedded short force flags cannot authorize restore', async () => {
  const validate = S3BackupManager.prototype.validate;
  const restore = S3BackupManager.prototype.restore;
  const dataPath = process.env.BUNQUEUE_DATA_PATH;
  S3BackupManager.prototype.validate = () => ({ valid: true, errors: [] });
  S3BackupManager.prototype.restore = async (key: string) => ({ success: true, key, duration: 0 });
  process.env.BUNQUEUE_DATA_PATH = '/tmp/audit-never-created.db';
  try {
    for (const flag of ['-xf=false', '-xfalse', '-xftrue']) {
      let result;
      try {
        result = await executeBackupCommand(['restore', 'audit-fixture', flag]);
      } catch {
        continue;
      }
      expect(result.success).toBe(false);
    }
  } finally {
    S3BackupManager.prototype.validate = validate;
    S3BackupManager.prototype.restore = restore;
    if (dataPath === undefined) delete process.env.BUNQUEUE_DATA_PATH;
    else process.env.BUNQUEUE_DATA_PATH = dataPath;
  }
});

for (const healthy of [true, false]) {
  test(`CLI: healthcheck JSON is safe with unused credential-bearing TCP env (${healthy})`, async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ status: healthy ? 'healthy' : 'unhealthy' }),
    });
    try {
      const result = await runCliRaw(['healthcheck', server.url.href, '--json'], 5000, {
        TCP_PORT: 'http://audit-user:audit-secret@invalid.example/private',
      });
      expect(result.exitCode).toBe(healthy ? 0 : 1);
      const document = healthy ? result.stdout : result.stderr;
      expect(result.stdout + result.stderr).not.toContain('audit-secret');
      expect(() => JSON.parse(document)).not.toThrow();
      expect(JSON.parse(document).ok).toBe(healthy);
      expect(healthy ? result.stderr : result.stdout).toBe('');
    } finally {
      await server.stop(true);
    }
  });
}

test('CLI: family-level markers protect parsed log text and literal terminators', async () => {
  for (const message of ['--json', '--']) {
    const parsed = parseGlobalOptions(['job', '--', 'log', 'audit-job', message]);
    expect(await buildCommand(parsed.commandArgs[0], parsed.commandArgs.slice(1))).toEqual({
      cmd: 'AddLog',
      id: 'audit-job',
      message,
      level: 'info',
    });
  }
});

test('CLI: backup family markers preserve protected force and config tokens', async () => {
  const validate = S3BackupManager.prototype.validate;
  const restore = S3BackupManager.prototype.restore;
  const dataPath = process.env.BUNQUEUE_DATA_PATH;
  const restored: string[] = [];
  S3BackupManager.prototype.validate = () => ({ valid: true, errors: [] });
  S3BackupManager.prototype.restore = async (key: string) => {
    restored.push(key);
    return { success: true, key, duration: 0 };
  };
  process.env.BUNQUEUE_DATA_PATH = '/tmp/audit-never-created.db';
  try {
    expect((await executeBackupCommand(['--', 'status'])).success).toBe(true);
    const result = await executeBackupCommand(['--', 'restore', '--force']);
    expect(result.success).toBe(false);
    const configKey = await executeBackupCommand(['--', 'restore', '--config']);
    expect(configKey.success).toBe(false);
    expect(restored).toEqual([]);
  } finally {
    S3BackupManager.prototype.validate = validate;
    S3BackupManager.prototype.restore = restore;
    if (dataPath === undefined) delete process.env.BUNQUEUE_DATA_PATH;
    else process.env.BUNQUEUE_DATA_PATH = dataPath;
  }
});

test('CLI: healthcheck ignores invalid unused TCP flags and their diagnostics', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ status: 'healthy' }),
  });
  try {
    const result = await runCliRaw([
      'healthcheck',
      server.url.href,
      '--json',
      '--tls-ca=',
      '--token',
      '--port=http://audit-user:audit-secret@invalid.example/private',
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, status: 'healthy' });
    expect(result.stderr).toBe('');
    expect(result.stdout + result.stderr).not.toContain('audit-secret');
  } finally {
    await server.stop(true);
  }
});
