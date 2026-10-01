/**
 * Repro: cleanup's 30-minute orphan window overrode the stall configuration.
 *
 * Orphan recovery is a backstop for the stall checker. It recovered a silent,
 * lockless job after 30 minutes even when the job allowed itself a longer
 * `stallTimeout`, when the queue's `stallInterval` was longer, or when stall
 * detection was disabled for the queue, so an explicitly long-running job could
 * be retried and run twice.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { cleanup } from '../src/application/cleanupTasks';
import type { BackgroundContext } from '../src/application/types';
import type { Job } from '../src/domain/types/job';
import { processingShardIndex } from '../src/shared/hash';

const THIRTY_ONE_MINUTES = 31 * 60 * 1000;
const TWO_HOURS = 2 * 60 * 60 * 1000;

function backgroundContext(qm: QueueManager): BackgroundContext {
  return (
    qm as unknown as { contextFactory: { getBackgroundContext(): BackgroundContext } }
  ).contextFactory.getBackgroundContext();
}

/** Pull a lockless job and make it look silent for 31 minutes. */
async function silentActiveJob(qm: QueueManager, queue: string): Promise<Job['id']> {
  const pulled = await qm.pull(queue);
  expect(pulled).not.toBeNull();
  const ctx = backgroundContext(qm);
  const job = ctx.processingShards[processingShardIndex(pulled!.id)].get(pulled!.id) as Job;
  const longAgo = Date.now() - THIRTY_ONE_MINUTES;
  job.startedAt = longAgo;
  job.lastHeartbeat = longAgo;
  return pulled!.id;
}

async function expectStillActiveAndAckable(qm: QueueManager, id: Job['id']): Promise<void> {
  await cleanup(backgroundContext(qm));
  expect(await qm.getJobState(id)).toBe('active');
  expect((await qm.getJob(id))?.attempts).toBe(0);
  await qm.ack(id, { done: true });
  expect(await qm.getJobState(id)).toBe('completed');
}

let qm: QueueManager | undefined;

afterEach(() => {
  qm?.shutdown();
  qm = undefined;
});

describe('orphan recovery respects the stall configuration', () => {
  test("a job's own longer stallTimeout is honored", async () => {
    qm = new QueueManager();
    await qm.push('long-job-timeout', { data: {}, maxAttempts: 3, stallTimeout: TWO_HOURS });
    const id = await silentActiveJob(qm, 'long-job-timeout');
    await expectStillActiveAndAckable(qm, id);
  });

  test("the queue's longer stallInterval is honored", async () => {
    qm = new QueueManager();
    qm.setStallConfig('long-queue-interval', { stallInterval: TWO_HOURS });
    await qm.push('long-queue-interval', { data: {}, maxAttempts: 3 });
    const id = await silentActiveJob(qm, 'long-queue-interval');
    await expectStillActiveAndAckable(qm, id);
  });

  test('a queue with stall detection disabled is left alone', async () => {
    qm = new QueueManager();
    qm.setStallConfig('stall-disabled', { enabled: false });
    await qm.push('stall-disabled', { data: {}, maxAttempts: 3 });
    const id = await silentActiveJob(qm, 'stall-disabled');
    await expectStillActiveAndAckable(qm, id);
  });
});
