/**
 * Queue concurrency slots are owned per job (model seed 418721315, path 108).
 *
 * A limit set while jobs of the queue are already active counts them, and every
 * path that ends an active delivery frees exactly the slot that job holds. A job
 * that holds no slot (a retried job completed late, or a job released twice)
 * never frees the slot of another job.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { checkExpiredLocks } from '../src/application/lockManager';
import { handleStalledJob } from '../src/application/stallDetection';
import type { BackgroundContext, LockContext } from '../src/application/types';
import type { Job, JobId } from '../src/domain/types/job';
import { StallAction } from '../src/domain/types/stall';
import { processingShardIndex } from '../src/shared/hash';

interface Contexts {
  getBackgroundContext(): BackgroundContext;
  getLockContext(): LockContext;
}

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

/** Pulls until the gate closes and returns how many jobs it admitted. */
async function admitted(manager: QueueManager, queue: string): Promise<number> {
  let count = 0;
  while ((await manager.pull(queue, 0)) !== null) count++;
  return count;
}

/**
 * One job of `queue` becomes active before the limit exists, then the limit is
 * set to 2 and one more job takes the second slot, so the gate is closed.
 */
async function earlyJobUnderLimit(queue: string, lockTtl?: number) {
  const manager = new QueueManager();
  qm = manager;
  await manager.push(queue, { data: { role: 'early' }, maxAttempts: 5, backoff: 60_000 });
  const pulled = await manager.pullWithLock(queue, 'early-worker', 0, lockTtl ?? 60_000);
  const early = pulled.job!;
  manager.setConcurrency(queue, 2);
  for (let i = 0; i < 4; i++) await manager.push(queue, { data: { role: 'late', i } });
  expect(await manager.pull(queue, 0)).not.toBeNull();
  expect(await manager.pull(queue, 0)).toBeNull();
  return { manager, early, token: pulled.token! };
}

type Release = (manager: QueueManager, id: JobId, token: string) => Promise<unknown>;

const releasePaths: Array<[string, Release]> = [
  ['ack', (m, id, token) => m.ack(id, 'done', token)],
  ['fail with a retry', (m, id, token) => m.fail(id, 'boom', token)],
  ['fail to the DLQ', (m, id, token) => m.fail(id, 'boom', token, true)],
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

describe('a job active before the limit frees exactly its own slot', () => {
  for (const [name, release] of releasePaths) {
    test(name, async () => {
      const queue = `early-${name.replaceAll(' ', '-')}`;
      const { manager, early, token } = await earlyJobUnderLimit(queue);

      await release(manager, early.id, token);

      expect(await admitted(manager, queue)).toBe(1);
      expect(manager.getQueueJobCounts(queue).active).toBe(2);
    });
  }

  test('lock expiry', async () => {
    const queue = 'early-lock-expiry';
    const { manager } = await earlyJobUnderLimit(queue, 40);
    await Bun.sleep(80);

    await checkExpiredLocks(contexts(manager).getLockContext());

    expect(await admitted(manager, queue)).toBe(1);
    expect(manager.getQueueJobCounts(queue).active).toBe(2);
  });
});

describe('a job without a slot never frees another job slot', () => {
  test('a late completion of a retried job keeps the running job counted', async () => {
    const manager = new QueueManager();
    qm = manager;
    const queue = 'late-retried-completion';
    manager.setConcurrency(queue, 1);
    await manager.push(queue, { data: { role: 'retried' }, maxAttempts: 5, backoff: 60_000 });
    await manager.push(queue, { data: { role: 'running' } });

    const retried = (await manager.pull(queue, 0))!;
    await manager.fail(retried.id, 'boom');
    expect(await manager.getJobState(retried.id)).toBe('delayed');
    expect(await manager.pull(queue, 0)).not.toBeNull();

    // The retried job is back in the queue: completing it releases nothing it holds.
    await manager.ack(retried.id, 'late');
    expect(await manager.getJobState(retried.id)).toBe('completed');

    await manager.push(queue, { data: { role: 'blocked' } });
    expect(await manager.pull(queue, 0)).toBeNull();
    expect(manager.getQueueJobCounts(queue).active).toBe(1);
  });

  test('the seed counts only the active jobs of the limited queue', async () => {
    const manager = new QueueManager();
    qm = manager;
    for (let i = 0; i < 3; i++) await manager.push('seed-other', { data: { i } });
    for (let i = 0; i < 4; i++) await manager.push('seed-limited', { data: { i } });
    expect(await manager.pullBatch('seed-other', 3)).toHaveLength(3);
    expect(await manager.pull('seed-limited', 0)).not.toBeNull();

    manager.setConcurrency('seed-limited', 2);

    expect(await admitted(manager, 'seed-limited')).toBe(1);
    expect(manager.getQueueLimitStatus('seed-limited').maxed).toBe(true);
  });

  test('raising the limit keeps the running jobs counted', async () => {
    const manager = new QueueManager();
    qm = manager;
    const queue = 'raise-limit';
    for (let i = 0; i < 5; i++) await manager.push(queue, { data: { i } });
    expect(await manager.pull(queue, 0)).not.toBeNull();
    manager.setConcurrency(queue, 1);
    expect(await manager.pull(queue, 0)).toBeNull();

    manager.setConcurrency(queue, 3);

    expect(await admitted(manager, queue)).toBe(2);
    expect(manager.getQueueJobCounts(queue).active).toBe(3);
  });
});

describe('a restored limit starts from the jobs active after recovery', () => {
  test('startup recovery requeues the stored active job and admits up to the limit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bunqueue-limit-restart-'));
    const dataPath = join(directory, 'queue.db');
    try {
      const before = new QueueManager({ dataPath });
      qm = before;
      const queue = 'limit-restart';
      before.setConcurrency(queue, 1);
      for (let i = 0; i < 3; i++) await before.push(queue, { data: { i }, durable: true });
      expect(await before.pull(queue, 0)).not.toBeNull();
      before.shutdown();

      const after = new QueueManager({ dataPath });
      qm = after;
      expect(after.getQueueLimitStatus(queue).concurrencyLimit).toBe(1);
      expect(after.getQueueJobCounts(queue).active).toBe(0);
      expect(await admitted(after, queue)).toBe(1);
      expect(after.getQueueJobCounts(queue).active).toBe(1);
    } finally {
      qm?.shutdown();
      qm = null;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
