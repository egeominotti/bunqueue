import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { processPendingDependencies } from '../src/application/dependencyProcessor';
import type { JobId } from '../src/domain/types/job';
import { TcpClient } from '../src/client/tcp/client';
import { createTcpServer } from '../src/infrastructure/server/tcp';

let manager: QueueManager;
let directory: string | undefined;
let dataPath: string | undefined;

afterEach(() => {
  manager.shutdown();
  if (directory) rmSync(directory, { recursive: true, force: true });
  dataPath = directory = undefined;
});

function start(backend: string, cap = 2): void {
  if (backend === 'SQLite') {
    directory = mkdtempSync(join(tmpdir(), 'bunqueue-proof-lifetime-'));
    dataPath = join(directory, 'queue.db');
  }
  manager = new QueueManager({ dataPath, maxCompletedJobs: cap });
}

async function complete(queue: string, id: JobId): Promise<void> {
  expect((await manager.pull(queue))?.id).toBe(id);
  await manager.ack(id);
}

async function fillCache(): Promise<void> {
  const jobs = await manager.pushBatch(
    'fillers',
    Array.from({ length: 6 }, () => ({ data: {}, durable: true }))
  );
  const pulled = await manager.pullBatch('fillers', jobs.length);
  expect(pulled.length).toBe(jobs.length);
  await manager.ackBatch(pulled.map((job) => job.id));
}

describe.each(['memory', 'SQLite'])('%s retained dependency generations', (backend) => {
  test('a completed custom ID cannot be reused before the last blocked consumer releases it', async () => {
    start(backend);
    const source = await manager.push('source', { customId: 'source-id', data: {}, durable: true });
    const pending = await manager.push('pending', { data: {}, durable: true });
    const parent = await manager.push('parent', {
      data: {},
      dependsOn: [source.id, pending.id],
      durable: true,
    });
    await complete('source', source.id);
    const reuse = () =>
      manager.push('replacement', { customId: 'source-id', data: {}, durable: true });
    await expect(reuse()).rejects.toThrow('unresolved dependency consumers');
    await fillCache();
    await expect(reuse()).rejects.toThrow('unresolved dependency consumers');
    await complete('pending', pending.id);
    expect((await manager.pull('parent', 300))?.id).toBe(parent.id);
    expect((await reuse()).id).toBe(source.id);
    const next = await manager.push('next', { data: {}, dependsOn: [source.id] });
    expect(await manager.getJobState(next.id)).toBe('waiting-children');
  });

  test('a queued completion notification cannot satisfy a retried generation', async () => {
    start(backend);
    const runtime = manager as unknown as {
      scheduleDependencyFlush(): void;
      contextFactory: { getBackgroundContext(): Parameters<typeof processPendingDependencies>[0] };
    };
    runtime.scheduleDependencyFlush = () => {};
    const source = await manager.push('retry-source', { data: {}, durable: true });
    const parent = await manager.push('parent', {
      dependsOn: [source.id],
      data: {},
      durable: true,
    });
    await complete('retry-source', source.id);
    expect(manager.retryCompleted('retry-source', source.id)).toBe(1);
    await processPendingDependencies(runtime.contextFactory.getBackgroundContext());
    expect(await manager.getJobState(parent.id)).toBe('waiting-children');
    await complete('retry-source', source.id);
    await processPendingDependencies(runtime.contextFactory.getBackgroundContext());
    expect((await manager.pull('parent'))?.id).toBe(parent.id);
  });
});

test('ordinary memory completions do not spend the removed-completion FIFO budget', async () => {
  start('memory', 1);
  const removed = await manager.push('removed', { data: {}, removeOnComplete: true });
  await complete('removed', removed.id);
  const source = await manager.push('source', { data: {} });
  const other = await manager.push('other', { data: {} });
  const parent = await manager.push('parent', { data: {}, dependsOn: [source.id, other.id] });
  await complete('source', source.id);
  await fillCache();
  const late = await manager.push('late', { data: {}, dependsOn: [source.id, other.id] });
  expect(await manager.cancel(parent.id)).toBe(true);
  expect(await manager.getJobState(late.id)).toBe('waiting-children');
  await complete('other', other.id);
  expect((await manager.pull('late', 300))?.id).toBe(late.id);
  const proof = await manager.push('proof', { data: {}, dependsOn: [removed.id] });
  expect((await manager.pull('proof'))?.id).toBe(proof.id);
  expect(manager.getDepCompletions().has(source.id)).toBe(false);
});

test('PUSH and PUSHB recognize a cold completed SQLite row across restart', async () => {
  start('SQLite');
  const source = await manager.push('source', { data: {}, durable: true });
  const pending = await manager.push('pending', { data: {}, durable: true });
  await complete('source', source.id);
  await fillCache();
  manager.shutdown();
  manager = new QueueManager({ dataPath, maxCompletedJobs: 2 });
  expect(manager.getCompletedJobs().has(source.id)).toBe(false);
  const server = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
  const client = new TcpClient({ host: '127.0.0.1', port: server.server.port, pingInterval: 0 });
  try {
    await client.connect();
    const pushed = await client.send({
      cmd: 'PUSH',
      queue: 'ready',
      data: {},
      dependsOn: [source.id],
    });
    expect({ ok: pushed.ok, error: pushed.error }).toEqual({ ok: true, error: undefined });
    expect<string | undefined>((await manager.pull('ready'))?.id).toBe(pushed.id as string);
    const batch = await client.send({
      cmd: 'PUSHB',
      queue: 'blocked',
      jobs: [{ data: {}, dependsOn: [source.id, pending.id] }],
    });
    expect({ ok: batch.ok, error: batch.error }).toEqual({ ok: true, error: undefined });
    expect(await manager.pull('blocked')).toBeNull();
    await complete('pending', pending.id);
    expect<string | undefined>((await manager.pull('blocked', 300))?.id).toBe(
      (batch.ids as string[])[0]
    );
  } finally {
    client.close();
    server.stop();
  }
});
