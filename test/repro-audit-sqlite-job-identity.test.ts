import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import type { QueueManagerConfig } from '../src/application/types/config';

function database(options: QueueManagerConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bunqueue-job-identity-'));
  const config = { ...options, dataPath: join(dir, 'queue.db') };
  let manager = new QueueManager(config);
  return {
    get manager() {
      return manager;
    },
    reopen() {
      manager.shutdown();
      manager = new QueueManager(config);
      return manager;
    },
    close() {
      manager.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a durable waiting job survives a repeated push while its ID is cached', async () => {
  const db = database({ maxCustomIds: 2 });
  try {
    const original = await db.manager.push('inbox', {
      customId: 'invoice',
      durable: true,
      data: 'first payload',
    });
    await db.manager.push('other', { customId: 'other', durable: true, data: null });
    const duplicate = await db.manager.push('inbox', {
      customId: 'invoice',
      durable: true,
      data: 'retry payload',
    });
    const before = db.manager.getQueueJobCounts('inbox');
    const recovered = db.reopen();
    const pulled = await recovered.pull('inbox');
    expect({
      sameId: duplicate.id === original.id,
      waitingBeforeRestart: before.waiting,
      recoveredId: pulled?.id,
      recoveredData: pulled?.data,
    }).toEqual({
      sameId: true,
      waitingBeforeRestart: 1,
      recoveredId: original.id,
      recoveredData: 'first payload',
    });
  } finally {
    db.close();
  }
});

test('a producer retry with a cached ID cannot deliver an active durable job to a second worker', async () => {
  const db = database({ maxCustomIds: 2 });
  try {
    const input = { customId: 'invoice', durable: true, data: { amount: 25 } };
    const original = await db.manager.push('inbox', input);
    const first = await db.manager.pullWithLock('inbox', 'first-worker', 0, 60_000);
    expect(first.job?.id).toBe(original.id);
    expect(first.token).toBeTruthy();
    await db.manager.push('other', { customId: 'other', durable: true, data: null });
    const duplicate = await db.manager.push('inbox', input);
    const second = await db.manager.pullWithLock('inbox', 'second-worker', 0, 60_000);
    expect({
      duplicateId: duplicate.id,
      secondDelivery: second.job?.id ?? null,
      secondPayload: second.job?.data ?? null,
    }).toEqual({ duplicateId: original.id, secondDelivery: null, secondPayload: null });
  } finally {
    db.close();
  }
});

test('a repeated push preserves the manually parked generation of a custom ID', async () => {
  const db = database();
  try {
    const input = { customId: 'parent', data: 'original', durable: true };
    const parent = await db.manager.push('parents', input);
    expect((await db.manager.pull('parents'))?.id).toBe(parent.id);
    expect(await db.manager.moveToWaitingChildren(parent.id)).toBe(true);
    expect(await db.manager.getJobState(parent.id)).toBe('waiting-children');
    const duplicate = await db.manager.push('parents', { ...input, data: 'retried' });
    const counts = db.manager.getQueueJobCounts('parents');
    const recovered = db.reopen();
    const recoveredState = await recovered.getJobState(parent.id);
    const recoveredData = (await recovered.getJob(parent.id))?.data;
    const delivered = await recovered.pull('parents');
    expect({
      sameId: duplicate.id === parent.id,
      waiting: counts.waiting,
      parked: counts['waiting-children'],
      recoveredState,
      recoveredData,
      delivered: delivered?.id ?? null,
    }).toEqual({
      sameId: true,
      waiting: 0,
      parked: 1,
      recoveredState: 'waiting-children',
      recoveredData: 'original',
      delivered: null,
    });
  } finally {
    db.close();
  }
});

for (const prefix of ['daily', 'cron']) {
  test(`active one-off work with a ${prefix}: deduplication key survives restart`, async () => {
    const db = database();
    try {
      const job = await db.manager.push('reports', {
        data: 'nightly report',
        uniqueKey: `${prefix}:report`,
        durable: true,
        maxAttempts: 3,
        backoff: 0,
      });
      expect((await db.manager.pull('reports'))?.id).toBe(job.id);
      const recovered = db.reopen();
      const state = await recovered.getJobState(job.id);
      const counts = recovered.getQueueJobCounts('reports');
      const redelivery = await recovered.pull('reports');
      expect({ state, waiting: counts.waiting, failed: counts.failed, id: redelivery?.id }).toEqual(
        {
          state: 'waiting',
          waiting: 1,
          failed: 0,
          id: job.id,
        }
      );
    } finally {
      db.close();
    }
  });
}

test('a disconnected worker returns one-off work with a cron-prefixed key', async () => {
  const db = database();
  try {
    const job = await db.manager.push('reports', { data: 'once', uniqueKey: 'cron:report' });
    expect((await db.manager.pull('reports'))?.id).toBe(job.id);
    db.manager.registerClientJob('worker', job.id);
    expect(await db.manager.releaseClientJobs('worker')).toBe(1);
    expect(db.manager.getQueueJobCounts('reports').waiting).toBe(1);
    expect((await db.manager.pull('reports'))?.id).toBe(job.id);
  } finally {
    db.close();
  }
});

test('registering a cron preserves a waiting one-off that uses the same deduplication key', async () => {
  const db = database();
  try {
    const job = await db.manager.push('reports', {
      data: 'once',
      uniqueKey: 'cron:nightly',
      durable: true,
    });
    db.manager.addCron({
      name: 'nightly',
      queue: 'reports',
      data: 'scheduled',
      preventOverlap: true,
      repeatEvery: 60_000,
    });
    expect(db.manager.getQueueJobCounts('reports').waiting).toBe(1);
    expect((await db.reopen().pull('reports'))?.id).toBe(job.id);
  } finally {
    db.close();
  }
});
