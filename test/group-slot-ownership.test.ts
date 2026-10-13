/**
 * Group concurrency slots are owned per job.
 *
 * Every path that ends an active delivery frees exactly the group slot that job
 * holds, and a later outcome of the same job (a late ACK of a retried attempt, a
 * repeated release) never frees the slot of another active job of the group.
 * Jobs active before a group override exists count toward it, a failed handoff
 * gives its slot back, obliterate forgets every slot, and a restart starts from
 * the jobs active after recovery (none).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { checkExpiredLocks } from '../src/application/lockManager';
import { handleStalledJob } from '../src/application/stallDetection';
import type { BackgroundContext, LockContext } from '../src/application/types';
import { FailureReason } from '../src/domain/types/dlq';
import type { Job, JobId } from '../src/domain/types/job';
import { StallAction } from '../src/domain/types/stall';
import { processingShardIndex } from '../src/shared/hash';

interface Contexts {
  getBackgroundContext(): BackgroundContext;
  getLockContext(): LockContext;
}

const GROUP = { concurrency: 2 };

let qm: QueueManager | null = null;

afterEach(() => {
  qm?.shutdown();
  qm = null;
});

function contexts(manager: QueueManager): Contexts {
  return (manager as unknown as { contextFactory: Contexts }).contextFactory;
}

function processingJob(manager: QueueManager, id: JobId): Job {
  const ctx = contexts(manager).getBackgroundContext();
  const job = ctx.processingShards[processingShardIndex(id)].get(id);
  expect(job).toBeDefined();
  return job as Job;
}

/** Pulls with the group default until the gate closes; returns the admitted count. */
async function admitted(manager: QueueManager, queue: string): Promise<number> {
  let count = 0;
  while ((await manager.pull(queue, 0, undefined, GROUP)) !== null) count++;
  return count;
}

/** Two jobs of group `g` are active (the group is full) and three more wait. */
async function fullGroup(queue: string, lockTtl = 60_000) {
  const manager = new QueueManager();
  qm = manager;
  await manager.push(queue, {
    data: { role: 'early' },
    groupId: 'g',
    maxAttempts: 5,
    backoff: 60_000,
  });
  for (let i = 0; i < 3; i++) await manager.push(queue, { data: { i }, groupId: 'g' });
  const pulled = await manager.pullWithLock(queue, 'early-worker', 0, lockTtl, undefined, GROUP);
  expect(pulled.job).not.toBeNull();
  expect(await manager.pull(queue, 0, undefined, GROUP)).not.toBeNull();
  expect(await manager.pull(queue, 0, undefined, GROUP)).toBeNull();
  expect(manager.getGroupActiveCount(queue, 'g')).toBe(2);
  return { manager, early: pulled.job!, token: pulled.token! };
}

/**
 * After its slot is freed, a late ACK of the same job must not free another one.
 * A job that went back to waiting without a backoff is the group's FIFO head and
 * was admitted again; an ACK of that new delivery is not late, so it is skipped.
 */
async function expectNoSecondRelease(manager: QueueManager, queue: string, id: JobId) {
  if ((await manager.getJobState(id)) !== 'active') {
    await manager.ack(id, 'late').catch(() => undefined);
  }
  expect(manager.getGroupActiveCount(queue, 'g')).toBe(2);
  await manager.push(queue, { data: { role: 'blocked' }, groupId: 'g' });
  expect(await admitted(manager, queue)).toBe(0);
  expect(manager.getQueueJobCounts(queue).active).toBe(2);
}

type Release = (manager: QueueManager, id: JobId, token: string) => Promise<unknown>;

const releasePaths: Array<[string, Release]> = [
  ['ack', (m, id, token) => m.ack(id, 'done', token)],
  ['fail with a retry', (m, id, token) => m.fail(id, 'boom', token)],
  ['fail to the DLQ', (m, id, token) => m.fail(id, 'boom', token, true)],
  ['timeout', (m, id) => m.failWithReason(id, 'timed out', FailureReason.Timeout)],
  ['moveToDelayed', (m, id, token) => m.moveToDelayed(id, 60_000, token)],
  ['moveActiveToWait', (m, id, token) => m.moveActiveToWait(id, token)],
  ['moveToWaitingChildren', (m, id, token) => m.moveToWaitingChildren(id, token)],
  ['discard', (m, id, token) => m.discard(id, token)],
  [
    'stall recovery',
    (m, id) =>
      handleStalledJob(processingJob(m, id), StallAction.Retry, contexts(m).getBackgroundContext()),
  ],
  [
    'client disconnect',
    (m, id) => {
      m.registerClientJob('client-early', id);
      return m.releaseClientJobs('client-early');
    },
  ],
];

describe('an active job frees exactly its own group slot', () => {
  for (const [name, release] of releasePaths) {
    test(name, async () => {
      const queue = `group-exit-${name.replaceAll(' ', '-')}`;
      const { manager, early, token } = await fullGroup(queue);

      await release(manager, early.id, token);
      expect(manager.getGroupActiveCount(queue, 'g')).toBe(1);
      expect(await admitted(manager, queue)).toBe(1);

      await expectNoSecondRelease(manager, queue, early.id);
    });
  }

  test('lock expiry', async () => {
    const queue = 'group-exit-lock-expiry';
    const { manager, early } = await fullGroup(queue, 40);
    await Bun.sleep(80);

    await checkExpiredLocks(contexts(manager).getLockContext());
    expect(manager.getGroupActiveCount(queue, 'g')).toBe(1);
    expect(await admitted(manager, queue)).toBe(1);

    await expectNoSecondRelease(manager, queue, early.id);
  });
});

describe('group slot accounting outside the exit paths', () => {
  test('ackBatch of a retried job waiting in the queue keeps the running jobs counted', async () => {
    const queue = 'group-late-ack-batch';
    const { manager, early, token } = await fullGroup(queue);
    await manager.fail(early.id, 'boom', token);
    expect(await admitted(manager, queue)).toBe(1);

    await manager.ackBatch([early.id]);
    await manager.ackBatchWithResults([{ id: early.id, result: 'late' }]).catch(() => undefined);
    expect(await manager.getJobState(early.id)).toBe('completed');
    expect(manager.getGroupActiveCount(queue, 'g')).toBe(2);
    await manager.push(queue, { data: { role: 'blocked' }, groupId: 'g' });
    expect(await admitted(manager, queue)).toBe(0);
  });

  test('jobs active before the group override count toward it', async () => {
    const manager = new QueueManager();
    qm = manager;
    const queue = 'group-override-after-pull';
    for (let i = 0; i < 4; i++) await manager.push(queue, { data: { i }, groupId: 'g' });
    expect(await manager.pullBatch(queue, 2, 0, undefined, { concurrency: 10 })).toHaveLength(2);

    await manager.setGroupConcurrency(queue, 'g', 3);

    expect(await admitted(manager, queue)).toBe(1);
    expect(manager.getGroupActiveCount(queue, 'g')).toBe(3);
  });

  test('a failed handoff gives the group slot back', async () => {
    const manager = new QueueManager();
    qm = manager;
    const queue = 'group-aborted-handoff';
    for (let i = 0; i < 2; i++) await manager.push(queue, { data: { i }, groupId: 'g' });
    const controller = new AbortController();
    const pull = manager.pull(queue, 0, controller.signal, { concurrency: 1 });
    controller.abort();
    expect(await pull).toBeNull();

    expect(manager.getGroupActiveCount(queue, 'g')).toBe(0);
    expect(await manager.pull(queue, 0, undefined, { concurrency: 1 })).not.toBeNull();
    expect(await manager.pull(queue, 0, undefined, { concurrency: 1 })).toBeNull();
  });

  test('obliterate forgets the slots and a late outcome cannot free a new one', async () => {
    const queue = 'group-obliterate';
    const { manager, early, token } = await fullGroup(queue);
    manager.obliterate(queue);
    expect(manager.getGroupActiveCount(queue, 'g')).toBe(0);

    for (let i = 0; i < 3; i++) await manager.push(queue, { data: { i }, groupId: 'g' });
    expect(await admitted(manager, queue)).toBe(2);
    await manager.ack(early.id, 'late', token).catch(() => undefined);
    expect(manager.getGroupActiveCount(queue, 'g')).toBe(2);
    expect(await admitted(manager, queue)).toBe(0);
  });

  test('a restart starts from the jobs active after recovery', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bunqueue-group-restart-'));
    const dataPath = join(directory, 'queue.db');
    try {
      const before = new QueueManager({ dataPath });
      qm = before;
      const queue = 'group-restart';
      await before.setGroupConcurrency(queue, 'g', 1);
      for (let i = 0; i < 3; i++) {
        await before.push(queue, { data: { i }, groupId: 'g', durable: true });
      }
      expect(await before.pull(queue, 0, undefined, GROUP)).not.toBeNull();
      before.shutdown();

      const after = new QueueManager({ dataPath });
      qm = after;
      expect(after.getGroupConcurrency(queue, 'g')).toBe(1);
      expect(after.getGroupActiveCount(queue, 'g')).toBe(0);
      expect(await admitted(after, queue)).toBe(1);
      expect(after.getGroupActiveCount(queue, 'g')).toBe(1);
    } finally {
      qm?.shutdown();
      qm = null;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
