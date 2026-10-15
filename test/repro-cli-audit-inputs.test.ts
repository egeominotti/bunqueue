import { expect, test } from 'bun:test';
import { buildCommand } from '../src/cli/commandRouter';
import { parseGlobalOptions } from '../src/cli/globalOptions';
import { executeBackupCommand } from '../src/cli/commands/backup';
import { S3BackupManager } from '../src/infrastructure/backup';
import { QueueManager } from '../src/application/queueManager';
import { createTcpServer } from '../src/infrastructure/server/tcp';
import { runCliRaw } from './cli-invariants/runtimeHarness';

test('CLI: explicit false cannot enable deletion or reverse scheduling order', async () => {
  let command: Record<string, unknown> | null;
  try {
    command = await buildCommand('push', [
      'audit-booleans',
      '{}',
      '--remove-on-complete=false',
      '--remove-on-fail=false',
      '--lifo=false',
    ]);
  } catch {
    // Rejecting unsupported boolean syntax is also safe.
    return;
  }
  if (command === null) throw new Error('Expected a push command for explicit false options');
  expect(command.removeOnComplete).not.toBe(true);
  expect(command.removeOnFail).not.toBe(true);
  expect(command.lifo).not.toBe(true);
});

test('CLI: force=false must preserve the restore confirmation requirement', async () => {
  // The restore crosses the S3/filesystem boundary, so replace that operation only.
  const originalValidate = S3BackupManager.prototype.validate;
  const originalRestore = S3BackupManager.prototype.restore;
  const originalDataPath = process.env.BUNQUEUE_DATA_PATH;
  S3BackupManager.prototype.validate = () => ({ valid: true, errors: [] });
  S3BackupManager.prototype.restore = async (key: string) => ({ success: true, key, duration: 0 });
  process.env.BUNQUEUE_DATA_PATH = '/tmp/audit-never-created.db';
  try {
    const result = await executeBackupCommand(['restore', 'audit-fixture', '--force=false']);
    expect(result.success).toBe(false);
  } finally {
    S3BackupManager.prototype.validate = originalValidate;
    S3BackupManager.prototype.restore = originalRestore;
    if (originalDataPath === undefined) delete process.env.BUNQUEUE_DATA_PATH;
    else process.env.BUNQUEUE_DATA_PATH = originalDataPath;
  }
});

for (const state of ['prioritized', 'paused', 'waiting-children']) {
  test(`CLI: queue jobs can filter the supported ${state} state`, async () => {
    expect(await buildCommand('queue', ['jobs', 'audit-state', '--state', state])).toMatchObject({
      cmd: 'GetJobs',
      state,
    });
  });
}

test('CLI: the complete parser preserves an option-looking log message after --', async () => {
  const { commandArgs } = parseGlobalOptions(['job', 'log', 'audit-job', '--', '--json']);
  expect(await buildCommand(commandArgs[0], commandArgs.slice(1))).toMatchObject({
    message: '--json',
  });
});

for (const [flag, field] of [
  ['lifo', 'lifo'],
  ['remove-on-complete', 'removeOnComplete'],
  ['remove-on-fail', 'removeOnFail'],
]) {
  test(`CLI: ${flag} accepts explicit booleans and preserves bare switches`, async () => {
    expect(await buildCommand('push', ['q', '{}', `--${flag}=false`])).not.toHaveProperty(
      field,
      true
    );
    for (const spelling of [`--${flag}`, `--${flag}=true`]) {
      expect(await buildCommand('push', ['q', '{}', spelling])).toHaveProperty(field, true);
    }
    for (const value of ['', 'FALSE', '0', 'yes']) {
      await expect(buildCommand('push', ['q', '{}', `--${flag}=${value}`])).rejects.toThrow(
        /boolean/i
      );
    }
    await expect(buildCommand('push', ['q', '{}', `--${flag}`, 'false'])).rejects.toThrow(
      /=true|=false/
    );
    // A required JSON primitive remains data, even immediately after a bare switch.
    expect(await buildCommand('push', ['q', `--${flag}`, 'false'])).toMatchObject({
      data: false,
      [field]: true,
    });
  });
}

test('CLI: boolean options remain opaque when protected as positional data', async () => {
  expect(await buildCommand('push', ['--', '--lifo=false', 'false'])).toEqual({
    cmd: 'PUSH',
    queue: '--lifo=false',
    name: 'default',
    data: false,
  });
});

test('CLI: restore only crosses the destructive boundary for an enabled force flag', async () => {
  const validate = S3BackupManager.prototype.validate;
  const restore = S3BackupManager.prototype.restore;
  const dataPath = process.env.BUNQUEUE_DATA_PATH;
  const restoredKeys: string[] = [];
  S3BackupManager.prototype.validate = () => ({ valid: true, errors: [] });
  S3BackupManager.prototype.restore = async (key: string) => {
    restoredKeys.push(key);
    return { success: true, key, duration: 0 };
  };
  process.env.BUNQUEUE_DATA_PATH = '/tmp/audit-never-created.db';
  try {
    for (const flag of ['--force=false', '-f=false']) {
      expect((await executeBackupCommand(['restore', 'fixture', flag])).success).toBe(false);
      expect(restoredKeys).toEqual([]);
    }
    for (const value of ['', 'FALSE', '0', 'yes']) {
      await expect(
        executeBackupCommand(['restore', 'fixture', `--force=${value}`])
      ).rejects.toThrow(/boolean/i);
      expect(restoredKeys).toEqual([]);
    }
    await expect(executeBackupCommand(['restore', 'fixture', '--force', 'false'])).rejects.toThrow(
      /=true|=false/
    );
    expect(restoredKeys).toEqual([]);
    for (const args of [
      ['--force', 'false'],
      ['-f', 'false'],
      ['fixture', '-ffalse'],
    ]) {
      await expect(executeBackupCommand(['restore', ...args])).rejects.toThrow(/=true|=false/);
      expect(restoredKeys).toEqual([]);
    }
    for (const flag of ['--force', '-f', '--force=true', '-f=true']) {
      expect((await executeBackupCommand(['restore', 'fixture', flag])).success).toBe(true);
    }
    expect(restoredKeys).toEqual(['fixture', 'fixture', 'fixture', 'fixture']);
  } finally {
    S3BackupManager.prototype.validate = validate;
    S3BackupManager.prototype.restore = restore;
    if (dataPath === undefined) delete process.env.BUNQUEUE_DATA_PATH;
    else process.env.BUNQUEUE_DATA_PATH = dataPath;
  }
});

test('CLI: all eight listing states select the expected real broker jobs', async () => {
  const manager = new QueueManager();
  const tcp = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
  try {
    const queue = 'audit-all-list-states';
    const completed = await manager.push(queue, { data: {} });
    await manager.pull(queue);
    await manager.ack(completed.id);
    const failed = await manager.push(queue, { data: {}, maxAttempts: 1 });
    await manager.pull(queue);
    await manager.fail(failed.id, 'fixture');
    const active = await manager.push(queue, { data: {} });
    await manager.pull(queue);
    const waiting = await manager.push(queue, { data: {} });
    const delayed = await manager.push(queue, { data: {}, delay: 60_000 });
    const prioritized = await manager.push(queue, { data: {}, priority: 3 });
    const child = await manager.push(queue, { data: {}, dependsOn: [waiting.id] });
    for (const [state, expected] of [
      ['waiting', waiting],
      ['active', active],
      ['completed', completed],
      ['failed', failed],
      ['delayed', delayed],
      ['prioritized', prioritized],
      ['waiting-children', child],
    ] as const) {
      const result = await runCliRaw([
        '--host',
        '127.0.0.1',
        '--port',
        String(tcp.server.port),
        '--json',
        'queue',
        'jobs',
        queue,
        '--state',
        state,
      ]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).jobs.map((job: { id: string }) => job.id)).toEqual([
        String(expected.id),
      ]);
    }
    manager.pause(queue);
    const paused = await runCliRaw([
      '--host',
      '127.0.0.1',
      '--port',
      String(tcp.server.port),
      '--json',
      'queue',
      'jobs',
      queue,
      '--state',
      'paused',
    ]);
    expect(paused.exitCode).toBe(0);
    expect(
      JSON.parse(paused.stdout)
        .jobs.map((job: { id: string }) => job.id)
        .sort()
    ).toEqual([String(waiting.id), String(prioritized.id)].sort());
  } finally {
    tcp.stop();
    manager.shutdown();
  }
}, 15_000);

test('CLI: listing state expansion does not broaden clean acceptance', async () => {
  for (const state of ['prioritized', 'paused', 'waiting-children']) {
    await expect(
      buildCommand('queue', ['clean', 'q', '--grace', '0', '--state', state])
    ).rejects.toThrow(/Invalid state/);
  }
});

test('CLI: direct positional builders skip only the protective terminator', async () => {
  for (const [argv, expected] of [
    [['queue', 'pause', '--', '--json'], { cmd: 'Pause', queue: '--json' }],
    [['queue', 'resume', '--', '--'], { cmd: 'Resume', queue: '--' }],
    [['queue', 'count', '--', '--json'], { cmd: 'Count', queue: '--json' }],
    [['cron', 'delete', '--', '--json'], { cmd: 'CronDelete', name: '--json' }],
    [['worker', 'unregister', '--', '--json'], { cmd: 'UnregisterWorker', workerId: '--json' }],
    [['webhook', 'remove', '--', '--json'], { cmd: 'RemoveWebhook', webhookId: '--json' }],
    [['dlq', 'purge', '--', '--json'], { cmd: 'PurgeDlq', queue: '--json' }],
    [['rate-limit', 'set', '--', '--json', '2'], { cmd: 'RateLimit', queue: '--json', limit: 2 }],
    [
      ['concurrency', 'set', '--', '--json', '2'],
      { cmd: 'SetConcurrency', queue: '--json', limit: 2 },
    ],
  ] as const) {
    const { commandArgs } = parseGlobalOptions([...argv]);
    expect(await buildCommand(commandArgs[0], commandArgs.slice(1))).toEqual(expected);
  }
});

test('CLI: protected option-looking log text is actually stored verbatim', async () => {
  const manager = new QueueManager();
  const tcp = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
  try {
    const job = await manager.push('audit-protected-log', { data: {} });
    const result = await runCliRaw([
      '--host',
      '127.0.0.1',
      '--port',
      String(tcp.server.port),
      '--json',
      'job',
      'log',
      String(job.id),
      '--',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(manager.getLogs(job.id).map((entry) => entry.message)).toEqual(['--json']);
  } finally {
    tcp.stop();
    manager.shutdown();
  }
});
