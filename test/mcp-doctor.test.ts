import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { createTcpServer } from '../src/infrastructure/server/tcp';
import { WorkflowStore } from '../src/client/workflow/store';

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'bq-doctor-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function doctor(settings: Record<string, string>) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...settings };
  const proc = Bun.spawn(
    [process.execPath, '--no-env-file', 'src/mcp/index.ts', '--doctor', '--json'],
    {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10000,
    }
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exit, report: stdout ? JSON.parse(stdout) : null };
}

test('embedded doctor checks readiness without creating the queue database or binding HTTP', async () => {
  const dir = temporary();
  const path = join(dir, 'never-created.db');
  const result = await doctor({
    BUNQUEUE_DATA_PATH: path,
    BUNQUEUE_MCP_PROFILE: 'agent',
    BUNQUEUE_MCP_TRANSPORT: 'http',
    BUNQUEUE_MCP_HTTP_TOKEN: 'secret-http-token',
    BUNQUEUE_TOKEN: 'secret-broker-token',
  });
  expect(result.exit).toBe(0);
  expect(result.report).toMatchObject({
    ok: true,
    mode: 'embedded',
    profile: 'agent',
    transport: 'http',
    persistence: { kind: 'sqlite', configured: true },
    backend: { ready: true, check: 'filesystem' },
    confirmation: true,
  });
  expect(result.report.toolsets).toContain('monitoring');
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(dir)).toEqual([]);
  expect(result.stdout + result.stderr).not.toContain('secret-http-token');
  expect(result.stdout + result.stderr).not.toContain('secret-broker-token');
});

test('doctor rejects invalid profiles and missing workflow stores with nonzero status', async () => {
  const dir = temporary();
  const cases: Record<string, string>[] = [
    { BUNQUEUE_MCP_PROFILE: 'secret-invalid-profile' },
    { BUNQUEUE_MCP_WORKFLOW_DB: join(dir, 'missing.db') },
    { BUNQUEUE_MODE: 'wrong' },
  ];
  for (const env of cases) {
    const result = await doctor(env);
    expect(result.exit).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.stdout + result.stderr).not.toContain('secret-invalid-profile');
  }
  expect(readdirSync(dir)).toEqual([]);
});

test('doctor reports unchecked workflow schema and never initializes a foreign database', async () => {
  const dir = temporary();
  const path = join(dir, 'foreign.db');
  const db = new Database(path);
  db.run('CREATE TABLE untouched(value TEXT)');
  db.close();
  const before = await Bun.file(path).arrayBuffer();
  const result = await doctor({ BUNQUEUE_MCP_WORKFLOW_DB: path });
  expect(result.exit).toBe(0);
  expect(result.report.workflows).toMatchObject({
    configured: true,
    inspectionConfigured: true,
    schemaChecked: false,
  });
  expect(await Bun.file(path).arrayBuffer()).toEqual(before);
  expect(readdirSync(dir)).toEqual(['foreign.db']);
});

test('doctor recognizes an existing workflow store without changing its database', async () => {
  const dir = temporary();
  const path = join(dir, 'workflow.db');
  new WorkflowStore(path).close();
  const filesBefore = readdirSync(dir).sort();
  const before = await Bun.file(path).arrayBuffer();
  const result = await doctor({ BUNQUEUE_MCP_WORKFLOW_DB: path });
  expect(result.exit).toBe(0);
  expect(result.report.workflows).toMatchObject({
    configured: true,
    inspectionConfigured: true,
    schemaChecked: false,
  });
  expect(result.report.workflows).not.toHaveProperty('signal');
  expect(result.report.toolsets).toContain('workflows');
  expect(await Bun.file(path).arrayBuffer()).toEqual(before);
  expect(readdirSync(dir).sort()).toEqual(filesBefore);
});

test('doctor never creates sidecars for a dormant WAL-mode workflow database', async () => {
  const dir = temporary();
  const path = join(dir, 'dormant.db');
  const writer = new Database(path);
  writer.run('PRAGMA journal_mode=WAL');
  writer.run('CREATE TABLE workflow_executions(id TEXT)');
  writer.close();
  expect(readdirSync(dir)).toEqual(['dormant.db']);
  const before = await Bun.file(path).arrayBuffer();
  const result = await doctor({ BUNQUEUE_MCP_WORKFLOW_DB: path });
  expect(result.exit).toBe(0);
  expect(readdirSync(dir)).toEqual(['dormant.db']);
  expect(await Bun.file(path).arrayBuffer()).toEqual(before);
});

test('TCP doctor reads a fresh broker and closes without consuming queued work', async () => {
  const dir = temporary();
  const manager = new QueueManager({ dataPath: join(dir, 'broker.db') });
  const tcp = createTcpServer(manager, { port: 0, hostname: '127.0.0.1' });
  cleanups.push(() => {
    tcp.stop();
    manager.shutdown();
  });
  const queued = await manager.push('doctor-queued', { data: { task: 'untouched' } });
  const result = await doctor({
    BUNQUEUE_MODE: 'tcp',
    BUNQUEUE_HOST: '127.0.0.1',
    BUNQUEUE_PORT: String(tcp.server.port),
  });
  expect(result.exit).toBe(0);
  expect(result.report).toMatchObject({
    ok: true,
    mode: 'tcp',
    backend: { ready: true, check: 'broker_read' },
  });
  expect(manager.getQueueJobCounts('doctor-queued').waiting).toBe(1);
  expect(manager.getQueueJobCounts('doctor-queued').active).toBe(0);
  expect((await manager.getJob(queued.id))?.data).toEqual({ task: 'untouched' });
});

test('doctor never echoes a raw invalid pool setting through stderr warnings', async () => {
  const dir = temporary();
  const manager = new QueueManager({ dataPath: join(dir, 'broker.db') });
  const tcp = createTcpServer(manager, { port: 0, hostname: '127.0.0.1' });
  cleanups.push(() => {
    tcp.stop();
    manager.shutdown();
  });
  const result = await doctor({
    BUNQUEUE_MODE: 'tcp',
    BUNQUEUE_HOST: '127.0.0.1',
    BUNQUEUE_PORT: String(tcp.server.port),
    BUNQUEUE_POOL_SIZE: 'doctor-sentinel-invalid',
  });
  expect(result.exit).toBe(0);
  expect(result.report.ok).toBe(true);
  expect(result.stdout + result.stderr).not.toContain('doctor-sentinel-invalid');
  expect(manager.getQueueJobCounts('doctor-unused').active).toBe(0);
});
