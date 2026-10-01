/**
 * Repro: a genuinely orphaned active job must be recovered, not dropped.
 *
 * When cleanup found an active job with no heartbeat, progress or lock renewal
 * for 30 minutes and no live lock, it only deleted it from processingShards and
 * jobIndex. The queue concurrency slot stayed held, SQLite kept the row active,
 * no attempt was counted, and the job vanished until a restart brought it back.
 * An orphan is a stalled job, so it must take the stall recovery path: retry
 * with the attempt counted, or the DLQ once attempts are exhausted.
 *
 * A lease left from an earlier processing generation (stall retry keeps the old
 * lease in place) must not count as liveness for the current generation.
 */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { cleanup } from '../src/application/cleanupTasks';
import type { BackgroundContext } from '../src/application/types';
import type { Job, JobLock } from '../src/domain/types/job';
import { processingShardIndex } from '../src/shared/hash';

const THIRTY_ONE_MINUTES = 31 * 60 * 1000;
const FORTY_MINUTES = 40 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const TWO_HOURS = 2 * ONE_HOUR;
const QUEUED_STATES = ['waiting', 'prioritized', 'delayed'];

type MutableLock = { -readonly [K in keyof JobLock]: JobLock[K] };

function backgroundContext(qm: QueueManager): BackgroundContext {
  return (
    qm as unknown as { contextFactory: { getBackgroundContext(): BackgroundContext } }
  ).contextFactory.getBackgroundContext();
}

function processingJob(ctx: BackgroundContext, id: Job['id']): Job {
  const job = ctx.processingShards[processingShardIndex(id)].get(id);
  expect(job).toBeDefined();
  return job as Job;
}

/** Nothing has been heard from the job for 31 minutes. */
function silence(job: Job): void {
  const longAgo = Date.now() - THIRTY_ONE_MINUTES;
  job.startedAt = longAgo;
  job.lastHeartbeat = longAgo;
}

let qm: QueueManager | undefined;
let directory: string | undefined;

afterEach(() => {
  qm?.shutdown();
  qm = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('cleanup recovers a genuinely orphaned job like a stalled one', () => {
  test('the job is retried with the attempt counted and its concurrency slot is released', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);
    qm.setConcurrency('orphans', 1);

    const orphanJob = await qm.push('orphans', { data: { n: 1 }, maxAttempts: 3 });
    await qm.push('orphans', { data: { n: 2 } });
    expect((await qm.pull('orphans'))?.id).toBe(orphanJob.id);
    expect(await qm.pull('orphans')).toBeNull(); // the only slot is held

    silence(processingJob(ctx, orphanJob.id));
    await cleanup(ctx);

    expect(ctx.processingShards[processingShardIndex(orphanJob.id)].has(orphanJob.id)).toBe(false);
    expect(QUEUED_STATES).toContain(await qm.getJobState(orphanJob.id));
    expect((await qm.getJob(orphanJob.id))?.attempts).toBe(1);
    expect(await qm.pull('orphans')).not.toBeNull(); // the slot was released
  });

  test('with no attempts left the orphan moves to the DLQ', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);

    const orphanJob = await qm.push('orphans-last', { data: {}, maxAttempts: 1 });
    expect((await qm.pull('orphans-last'))?.id).toBe(orphanJob.id);

    silence(processingJob(ctx, orphanJob.id));
    await cleanup(ctx);

    expect(await qm.getJobState(orphanJob.id)).toBe('failed');
    expect(qm.getDlq('orphans-last').map((job) => job.id)).toEqual([orphanJob.id]);
  });

  test('SQLite no longer records the recovered orphan as active', async () => {
    directory = mkdtempSync(join(tmpdir(), 'bunqueue-orphan-recovery-'));
    const dataPath = join(directory, 'queue.db');
    qm = new QueueManager({ dataPath });
    const ctx = backgroundContext(qm);

    const orphanJob = await qm.push('orphans-sqlite', {
      data: {},
      maxAttempts: 3,
      durable: true,
    });
    expect((await qm.pull('orphans-sqlite'))?.id).toBe(orphanJob.id);

    silence(processingJob(ctx, orphanJob.id));
    await cleanup(ctx);
    qm.shutdown(); // flushes buffered writes
    qm = undefined;

    const db = new Database(dataPath, { readonly: true });
    const row = db.query('SELECT state FROM jobs WHERE id = ?').get(String(orphanJob.id)) as {
      state: string;
    } | null;
    db.close();
    expect(row).not.toBeNull();
    expect(row?.state).not.toBe('active');
  });

  test('a lease from an earlier processing generation does not keep the current one alive', async () => {
    qm = new QueueManager();
    const ctx = backgroundContext(qm);

    await qm.push('old-lease', { data: {}, maxAttempts: 3 });
    const { job, token } = await qm.pullWithLock('old-lease', 'worker-1', 0, TWO_HOURS);
    expect(token).not.toBeNull();
    const id = job!.id;

    // The lease was created by an earlier attempt and is still unexpired, but
    // the current processing generation started after it and has been silent
    // for 31 minutes.
    const now = Date.now();
    const lock = ctx.jobLocks.get(id) as MutableLock;
    lock.createdAt = now - FORTY_MINUTES;
    lock.lastRenewalAt = lock.createdAt;
    lock.expiresAt = now + ONE_HOUR;
    silence(processingJob(ctx, id));

    await cleanup(ctx);

    expect(ctx.processingShards[processingShardIndex(id)].has(id)).toBe(false);
    expect(QUEUED_STATES).toContain(await qm.getJobState(id));
  });
});
