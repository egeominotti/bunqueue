import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { processPendingDependencies } from '../src/application/dependencyProcessor';
import { jobId, type Job } from '../src/domain/types/job';
import type { SqliteStorage } from '../src/infrastructure/persistence/sqlite';
import { SHARD_COUNT, shardIndex } from '../src/shared/hash';

let manager: QueueManager;
let directory: string;
let path: string;

afterEach(() => {
  manager.shutdown();
  rmSync(directory, { recursive: true, force: true });
});

function open(dependencyCheckMs = 60_000) {
  directory = mkdtempSync(join(tmpdir(), 'bunqueue-dependency-promotion-'));
  path = join(directory, 'queue.db');
  manager = new QueueManager({ dataPath: path, maxCompletedJobs: 1, dependencyCheckMs });
  return manager as unknown as {
    storage: SqliteStorage;
    scheduleDependencyFlush(): void;
    runDependencyFlush(): Promise<void>;
    contextFactory: { getBackgroundContext(): Parameters<typeof processPendingDependencies>[0] };
  };
}

async function ack(job: Job): Promise<void> {
  expect((await manager.pull(job.queue))?.id).toBe(job.id);
  await manager.ack(job.id);
}

test.skipIf(SHARD_COUNT === 1)(
  'a failed cold lookup retries waiting parents and releases pins for successful shards',
  async () => {
    const runtime = open();
    runtime.scheduleDependencyFlush = () => {};
    const ctx = runtime.contextFactory.getBackgroundContext();
    const a = await manager.push('a', { data: {}, durable: true });
    const b = await manager.push('b', { data: {}, durable: true });
    const removed = await manager.push('removed', {
      data: {},
      durable: true,
      removeOnComplete: true,
    });
    const pending = await manager.push('parent-a', {
      data: {},
      durable: true,
      dependsOn: [a.id, b.id],
    });
    const good = await manager.push('parent-b', {
      data: {},
      durable: true,
      dependsOn: [removed.id],
    });
    expect(shardIndex(pending.queue)).not.toBe(shardIndex(good.queue));
    await ack(a);
    await ack(b);
    await ack(removed);
    const lookup = runtime.storage.loadCompletedJobIds.bind(runtime.storage);
    runtime.storage.loadCompletedJobIds = () => {
      runtime.storage.loadCompletedJobIds = lookup;
      throw new Error('one cold lookup failed');
    };

    await expect(processPendingDependencies(ctx)).rejects.toThrow('one cold lookup failed');
    expect(await manager.getJobState(pending.id)).toBe('waiting-children');
    expect(await manager.getJobState(good.id)).toBe('waiting');
    const db = new Database(path, { readonly: true });
    try {
      expect(
        db.query('SELECT pinned FROM dependency_completions WHERE job_id = ?').get(removed.id)
      ).toEqual({ pinned: 0 });
    } finally {
      db.close();
    }
    await processPendingDependencies(ctx);
    expect(await manager.getJobState(pending.id)).toBe('waiting');
    expect((await manager.pull(pending.queue))?.id).toBe(pending.id);
    expect((await manager.pull(good.queue))?.id).toBe(good.id);
    expect(await manager.pull(good.queue)).toBeNull();
  }
);

test('a partially checkpointed shard publishes each parent once and retries the final unpin', async () => {
  const runtime = open();
  runtime.scheduleDependencyFlush = () => {};
  const ctx = runtime.contextFactory.getBackgroundContext();
  const notifications: unknown[] = [];
  ctx.dashboardEmit = (event, data) => {
    if (event === 'job:dependencies-resolved') notifications.push(data.jobId);
  };
  const child = await manager.push('child', { data: {}, durable: true, removeOnComplete: true });
  const addParent = () =>
    manager.push('parents', { data: {}, durable: true, dependsOn: [child.id] });
  const first = await addParent();
  const second = await addParent();
  await ack(child);
  const checkpoint = runtime.storage.updateFlowParentResolution.bind(runtime.storage);
  runtime.storage.updateFlowParentResolution = (job, state) => {
    if (job.id === second.id) {
      runtime.storage.updateFlowParentResolution = checkpoint;
      throw new Error('second checkpoint failed');
    }
    return checkpoint(job, state);
  };
  await expect(processPendingDependencies(ctx)).rejects.toThrow('second checkpoint failed');
  expect(notifications).toEqual([first.id]);
  expect((await manager.getJob(second.id))?.timeline.at(-1)?.state).toBe('waiting-children');
  expect((await manager.pull('parents'))?.id).toBe(first.id);
  const unpin = runtime.storage.unpinDependencyCompletions.bind(runtime.storage);
  runtime.storage.unpinDependencyCompletions = () => {
    runtime.storage.unpinDependencyCompletions = unpin;
    throw new Error('unpin failed');
  };
  await expect(processPendingDependencies(ctx)).rejects.toThrow('unpin failed');
  await processPendingDependencies(ctx);
  expect(notifications).toEqual([first.id, second.id]);
  expect((await manager.pull('parents'))?.id).toBe(second.id);
  expect(await manager.pull('parents')).toBeNull();
  const db = new Database(path, { readonly: true });
  try {
    expect(
      db.query('SELECT pinned FROM dependency_completions WHERE job_id = ?').get(child.id)
    ).toEqual({ pinned: 0 });
  } finally {
    db.close();
  }
});

test('the fallback interval retries a failed event-driven flush without rescheduling its microtask', async () => {
  const runtime = open(50);
  let schedules = 0;
  runtime.scheduleDependencyFlush = () => {
    schedules++;
  };
  const a = await manager.push('a', { data: {}, durable: true });
  const b = await manager.push('b', { data: {}, durable: true });
  const parent = await manager.push('parent', { data: {}, durable: true, dependsOn: [a.id, b.id] });
  await ack(a);
  await ack(b);
  const lookup = runtime.storage.loadCompletedJobIds.bind(runtime.storage);
  let attempts = 0;
  runtime.storage.loadCompletedJobIds = (ids) => {
    if (++attempts === 1) throw new Error('temporary cold lookup failure');
    return lookup(ids);
  };
  const before = schedules;
  await runtime.runDependencyFlush();
  expect(schedules).toBe(before);
  expect((await manager.pull(parent.queue, 1500))?.id).toBe(parent.id);
  expect(attempts).toBe(2);
});

test('retrying a cold sibling before failure-policy promotion keeps the parent blocked', async () => {
  open();
  const a = await manager.push('a', { data: {}, durable: true });
  const bId = jobId('b');
  const parent = await manager.push('parent', {
    data: {},
    durable: true,
    dependsOn: [a.id, bId],
    childrenIds: [a.id, bId],
  });
  const b = await manager.push('b', {
    customId: bId,
    data: {},
    durable: true,
    parentId: parent.id,
    maxAttempts: 1,
    removeDependencyOnFailure: true,
  });
  await ack(a);
  await ack(await manager.push('filler', { data: {}, durable: true }));
  expect((await manager.pull('b'))?.id).toBe(b.id);
  const failure = manager.fail(b.id, 'failed', undefined, true);
  // Observe the committed edge removal in the microtasks before the promotion timer fires.
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await manager.getJob(parent.id))?.dependsOn.length === 1) break;
  }
  expect((await manager.getJob(parent.id))?.dependsOn).toEqual([a.id]);
  expect(manager.retryCompleted('a', a.id)).toBe(1);
  await failure;
  expect(await manager.getJobState(parent.id)).toBe('waiting-children');
  expect(await manager.pull(parent.queue)).toBeNull();
  await ack(a);
  expect((await manager.pull(parent.queue, 300))?.id).toBe(parent.id);
});

test('failure-policy replay checkpoints a promoted parent before a sibling is retried', async () => {
  open();
  const a = await manager.push('a', { data: {}, durable: true });
  const bId = jobId('b');
  const parent = await manager.push('parent', {
    data: {},
    durable: true,
    dependsOn: [a.id, bId],
    childrenIds: [a.id, bId],
  });
  const b = await manager.push('b', {
    customId: bId,
    data: {},
    durable: true,
    parentId: parent.id,
    maxAttempts: 1,
    removeDependencyOnFailure: true,
  });
  await ack(a);
  await ack(await manager.push('filler', { data: {}, durable: true }));
  expect((await manager.pull('b'))?.id).toBe(b.id);
  // Stop after FAIL commits its outbox and recover that durable record on the next open.
  (manager as unknown as { onChildDependencyOption(): Promise<void> }).onChildDependencyOption =
    async () => {};
  await manager.fail(b.id, 'failed', undefined, true);
  manager.shutdown();
  manager = new QueueManager({ dataPath: path, maxCompletedJobs: 1 });
  expect(await manager.getJobState(parent.id)).toBe('waiting');
  expect((await manager.getJob(parent.id))?.dependsOn).toEqual([a.id]);
  expect(manager.retryCompleted('a', a.id)).toBe(1);
  manager.shutdown();
  manager = new QueueManager({ dataPath: path, maxCompletedJobs: 1 });
  expect(await manager.getJobState(a.id)).toBe('waiting');
  expect(await manager.getJobState(parent.id)).toBe('waiting');
  expect((await manager.pull('parent'))?.id).toBe(parent.id);
  expect(await manager.pull('parent')).toBeNull();
});
