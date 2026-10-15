import { expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { buildCommand } from '../src/cli/commandRouter';
import { fetchDoctorHealth } from '../src/cli/commands/doctor';
import { collectVersionInfo } from '../src/cli/localOutput';
import { clientTimeoutFor } from '../src/cli/client';
import { formatOutput } from '../src/cli/output';
import { parseGlobalOptions } from '../src/cli/globalOptions';
import { createHttpServer } from '../src/infrastructure/server/http';
import { createTcpServer } from '../src/infrastructure/server/tcp';
import { runCli, runCliRaw } from './cli-invariants/runtimeHarness';

test('CLI: DLQ text retains the real stored failure metadata', async () => {
  const manager = new QueueManager();
  const tcp = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
  try {
    const queue = 'audit-dlq-error';
    const job = await manager.push(queue, { data: {}, maxAttempts: 1 });
    await manager.pull(queue);
    await manager.fail(job.id, 'audit-original-failure');
    const entry = manager.getDlqEntries(queue)[0];
    expect(entry.error).toBe('audit-original-failure');
    const result = await runCli(['dlq', 'list', queue, '--host', '127.0.0.1'], tcp.server.port);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('audit-original-failure');
    expect(result.stdout).toContain(new Date(entry.enteredAt).toISOString());
  } finally {
    tcp.stop();
    manager.shutdown();
  }
});

test('CLI: omitted job wait timeout returns the broker outcome rather than a client timeout', async () => {
  const manager = new QueueManager();
  const tcp = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
  try {
    const job = await manager.push('audit-default-wait', { data: {} });
    const result = await runCli(
      ['job', 'wait', String(job.id), '--host', '127.0.0.1', '--json'],
      tcp.server.port,
      45_000
    );
    expect(result.timedOut).toBe(false);
    expect(result.stderr).not.toContain('Command timeout');
    expect(result.stderr).toContain('Job not completed within timeout');
  } finally {
    tcp.stop();
    manager.shutdown();
  }
}, 50_000);

test('CLI: healthcheck respects the global JSON output contract', async () => {
  const manager = new QueueManager();
  const http = createHttpServer(manager, { hostname: '127.0.0.1', port: 0 });
  try {
    const url = new URL('health', http.server.url).href;
    const result = await runCliRaw(['healthcheck', url, '--json']);
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, status: 'healthy' });
    expect(result.stderr).toBe('');
  } finally {
    http.stop();
    manager.shutdown();
  }
});

test('CLI: healthcheck accepts a protected URL positional', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ status: 'healthy' }),
  });
  try {
    const result = await runCliRaw([
      'healthcheck',
      '--json',
      '--',
      `http://127.0.0.1:${server.port}/health`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, status: 'healthy' });
    expect(result.stderr).toBe('');
  } finally {
    await server.stop(true);
  }
});

for (const [name, args] of [
  ['invalid URL', ['http://user:secret@invalid.example/private', 'extra']],
  ['unsupported URL', ['file:///private/secret']],
] as const) {
  test(`CLI: healthcheck JSON failure is one safe document for ${name}`, async () => {
    const result = await runCliRaw(['healthcheck', ...args, '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: 'Health check failed' });
  });
}

test('CLI: unhealthy HTTP responses produce a safe JSON failure', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ status: 'degraded', secret: 'private-payload' }, { status: 503 }),
  });
  try {
    const result = await runCliRaw([
      'healthcheck',
      `http://127.0.0.1:${server.port}/health`,
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: 'Health check failed' });
  } finally {
    await server.stop(true);
  }
});

test('CLI: default wait budget includes network allowance without extending ordinary commands', () => {
  expect(clientTimeoutFor({ cmd: 'WaitJob' })).toBe(40_000);
  expect(clientTimeoutFor({ cmd: 'WaitJob', timeout: 30_000 })).toBe(40_000);
  expect(clientTimeoutFor({ cmd: 'PUSH', timeout: 600_000 })).toBe(30_000);
  expect(clientTimeoutFor({ cmd: 'PULL' })).toBe(30_000);
});

test('CLI: DLQ entries override stale job metadata and legacy jobs remain readable', () => {
  const job = { id: 'dlq-job', queue: 'audit', error: 'stale', createdAt: 1, failedAt: 2 };
  const response = { ok: true, jobs: [job], entries: [{ job, error: 'actual', enteredAt: 1000 }] };
  const text = formatOutput(response, 'dlq', false);
  expect(text).toContain('actual');
  expect(text).toContain('1970-01-01T00:00:01.000Z');
  expect(text).not.toContain('stale');
  expect(formatOutput({ ok: true, jobs: [job] }, 'dlq', false)).toContain('stale');
  expect(formatOutput({ ok: true, jobs: [job], entries: [] }, 'dlq', false)).toContain(
    'DLQ is empty'
  );
});

for (const diagnostic of ['doctor', 'version'] as const) {
  test(`CLI: ${diagnostic} reaches a healthy bare IPv6 host`, async () => {
    const manager = new QueueManager();
    const http = createHttpServer(manager, { hostname: '::1', port: 0 });
    try {
      const port = Number(new URL(http.server.url).port);
      expect((await (await fetch(`http://[::1]:${port}/health`)).json()).status).toBe('healthy');
      if (diagnostic === 'doctor') {
        expect((await fetchDoctorHealth('::1', port)).kind).toBe('ok');
        expect((await fetchDoctorHealth('[::1]', port)).kind).toBe('ok');
      } else {
        expect((await collectVersionInfo('::1', port)).server.reachable).toBe(true);
        expect((await collectVersionInfo('[::1]', port)).server.reachable).toBe(true);
      }
      for (const host of ['::1', '[::1]']) {
        const result = await runCli([diagnostic, '--host', host, '--json'], port - 1);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        const output = JSON.parse(result.stdout);
        expect(diagnostic === 'doctor' ? output.reachable : output.server.reachable).toBe(true);
      }
    } finally {
      http.stop();
      manager.shutdown();
    }
  });
}

test('CLI: the documented progress message flag stores the message', async () => {
  expect(
    await buildCommand('job', ['progress', 'audit-job', '50', '--msg', 'working'])
  ).toMatchObject({ cmd: 'Progress', message: 'working' });
});

test('CLI: progress message aliases reach the stored job', async () => {
  const manager = new QueueManager();
  const tcp = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
  try {
    const job = await manager.push('audit-progress-alias', { data: {} });
    await manager.pull('audit-progress-alias');
    for (const alias of ['--msg', '--message', '-m']) {
      const message = `working via ${alias}`;
      const result = await runCli(
        ['job', 'progress', String(job.id), '50', alias, message, '--host', '127.0.0.1'],
        tcp.server.port
      );
      expect(result.exitCode).toBe(0);
      expect(await manager.getProgress(job.id)).toEqual({ progress: 50, message });
    }
  } finally {
    tcp.stop();
    manager.shutdown();
  }
});

test('CLI: direct job positionals preserve option-looking IDs and a literal terminator', async () => {
  for (const [subcommand, args, expected] of [
    ['get', ['--json'], { cmd: 'GetJob', id: '--json' }],
    ['state', ['--'], { cmd: 'GetState', id: '--' }],
    ['result', ['--json'], { cmd: 'GetResult', id: '--json' }],
    ['cancel', ['--json'], { cmd: 'Cancel', id: '--json' }],
    ['update', ['--json', '{"keep":true}'], { cmd: 'Update', id: '--json', data: { keep: true } }],
    ['priority', ['--json', '5'], { cmd: 'ChangePriority', id: '--json', priority: 5 }],
    ['promote', ['--json'], { cmd: 'Promote', id: '--json' }],
    ['delay', ['--json', '100'], { cmd: 'MoveToDelayed', id: '--json', delay: 100 }],
    ['discard', ['--json'], { cmd: 'Discard', id: '--json' }],
    ['logs', ['--json'], { cmd: 'GetLogs', id: '--json' }],
  ] as const) {
    const parsed = parseGlobalOptions(['job', subcommand, '--', ...args]);
    expect(parsed.options.json).toBe(false);
    expect(await buildCommand(parsed.commandArgs[0], parsed.commandArgs.slice(1))).toEqual(
      expected
    );
  }
});

test('CLI: worker registration guidance does not advertise an unsupported processor command', async () => {
  const manager = new QueueManager();
  const tcp = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
  try {
    const result = await runCli(
      ['worker', 'register', 'audit-worker', '--queues', 'audit-warning', '--host', '127.0.0.1'],
      tcp.server.port
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('SDK');
    expect(result.stderr).not.toContain('--processor');
  } finally {
    tcp.stop();
    manager.shutdown();
  }
});
