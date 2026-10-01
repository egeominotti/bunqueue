/**
 * Boundaries of cleanup's orphan window (see
 * repro-orphan-window-respects-stall-config).
 *
 * The window is max(30 minutes, job.stallTimeout ?? queue stallInterval) on a
 * queue whose stall detection is enabled, and only past the queue's
 * gracePeriod. A longer stall window postpones recovery; it does not disable
 * it. The rule is re-evaluated with the stall-path locks held, so a stall
 * configuration change that lands while the sweep waits is honored.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { cleanup } from '../src/application/cleanupTasks';
import type { BackgroundContext } from '../src/application/types';
import type { Job } from '../src/domain/types/job';
import { processingShardIndex, shardIndex } from '../src/shared/hash';

const MINUTE = 60 * 1000;
const TWO_HOURS = 120 * MINUTE;
const QUEUED_STATES = ['waiting', 'prioritized', 'delayed'];

function backgroundContext(qm: QueueManager): BackgroundContext {
  return (
    qm as unknown as { contextFactory: { getBackgroundContext(): BackgroundContext } }
  ).contextFactory.getBackgroundContext();
}

/** Pull a lockless job and make it look silent for `silentFor` ms. */
async function silentActiveJob(qm: QueueManager, queue: string, silentFor: number) {
  const pulled = await qm.pull(queue);
  expect(pulled).not.toBeNull();
  const ctx = backgroundContext(qm);
  const job = ctx.processingShards[processingShardIndex(pulled!.id)].get(pulled!.id) as Job;
  const since = Date.now() - silentFor;
  job.startedAt = since;
  job.lastHeartbeat = since;
  return pulled!.id;
}

async function expectRecovered(qm: QueueManager, id: Job['id']): Promise<void> {
  expect(QUEUED_STATES).toContain(await qm.getJobState(id));
  expect((await qm.getJob(id))?.attempts).toBe(1);
}

async function expectKept(qm: QueueManager, id: Job['id']): Promise<void> {
  expect(await qm.getJobState(id)).toBe('active');
  expect((await qm.getJob(id))?.attempts).toBe(0);
}

let qm: QueueManager | undefined;

afterEach(() => {
  qm?.shutdown();
  qm = undefined;
});

describe('orphan window boundaries', () => {
  test("a job's longer stallTimeout postpones recovery but does not disable it", async () => {
    qm = new QueueManager();
    await qm.push('job-window', { data: {}, maxAttempts: 3, stallTimeout: TWO_HOURS });
    const id = await silentActiveJob(qm, 'job-window', TWO_HOURS + MINUTE);
    await cleanup(backgroundContext(qm));
    await expectRecovered(qm, id);
  });

  test("the queue's longer stallInterval postpones recovery but does not disable it", async () => {
    qm = new QueueManager();
    qm.setStallConfig('queue-window', { stallInterval: TWO_HOURS });
    await qm.push('queue-window', { data: {}, maxAttempts: 3 });
    const id = await silentActiveJob(qm, 'queue-window', TWO_HOURS + MINUTE);
    await cleanup(backgroundContext(qm));
    await expectRecovered(qm, id);
  });

  test('a short stall window keeps the 30-minute floor', async () => {
    qm = new QueueManager();
    qm.setStallConfig('floor', { stallInterval: MINUTE });
    await qm.push('floor', { data: {}, maxAttempts: 3 });
    const id = await silentActiveJob(qm, 'floor', 29 * MINUTE);
    await cleanup(backgroundContext(qm));
    await expectKept(qm, id);
  });

  test("a job still inside the queue's gracePeriod is kept", async () => {
    qm = new QueueManager();
    qm.setStallConfig('long-grace', { gracePeriod: TWO_HOURS });
    await qm.push('long-grace', { data: {}, maxAttempts: 3 });
    const id = await silentActiveJob(qm, 'long-grace', 31 * MINUTE);
    await cleanup(backgroundContext(qm));
    await expectKept(qm, id);
  });

  test('disabling stall detection while the sweep waits for the shard lock keeps the job', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);
    await qm.push('disabled-mid-sweep', { data: {}, maxAttempts: 3 });
    const id = await silentActiveJob(qm, 'disabled-mid-sweep', 31 * MINUTE);

    // Hold the queue shard (first lock of the stall path) between the sweep's phases.
    const guard = await ctx.shardLocks[shardIndex('disabled-mid-sweep')].acquireRead();
    let sweep: Promise<void>;
    try {
      sweep = cleanup(ctx);
      await Bun.sleep(5);
      qm.setStallConfig('disabled-mid-sweep', { enabled: false });
    } finally {
      guard.release();
    }
    await sweep;

    await expectKept(qm, id);
  });
});
