/**
 * Issue #83: Wrong job state after server restart
 * https://github.com/egeominotti/bunqueue/issues/83
 *
 * After restart, getState()/getJobState() return "unknown" for jobs that
 * completed successfully pre-restart. The in-memory jobIndex/completedJobs
 * are not repopulated for completed jobs from SQLite during recovery.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';
import { unlink } from 'fs/promises';

const TEST_RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DB_PATH = `/tmp/test-issue-83-${TEST_RUN_ID}.db`;

async function cleanupDb() {
  if (await Bun.file(DB_PATH).exists()) await unlink(DB_PATH);
  if (await Bun.file(DB_PATH + '-wal').exists()) await unlink(DB_PATH + '-wal');
  if (await Bun.file(DB_PATH + '-shm').exists()) await unlink(DB_PATH + '-shm');
}

describe('Issue #83: job state after server restart', () => {
  beforeEach(async () => {
    shutdownManager();
    await cleanupDb();
    Bun.env.DATA_PATH = DB_PATH;
  });

  afterEach(async () => {
    shutdownManager();
    await cleanupDb();
    delete Bun.env.DATA_PATH;
  });

  test('getJobState returns "completed" for completed job after restart', async () => {
    const QUEUE = 'issue-83-completed';

    // Phase 1: add + complete a job
    let queue = new Queue(QUEUE, { embedded: true });
    const worker = new Worker(QUEUE, async () => ({ done: true }), {
      embedded: true,
      removeOnComplete: false,
    });

    const job = await queue.add('task', { hello: 'world' }, { durable: true });
    const jobId = String(job.id);

    // wait for worker to complete
    for (let i = 0; i < 50; i++) {
      const state = await queue.getJobState(jobId);
      if (state === 'completed') break;
      await Bun.sleep(50);
    }

    expect(await queue.getJobState(jobId)).toBe('completed');

    // Phase 2: simulate restart
    await worker.close();
    queue.close();
    shutdownManager();
    await Bun.sleep(100);

    // Phase 3: fresh Queue after restart — getJobState must still say "completed"
    Bun.env.DATA_PATH = DB_PATH;
    queue = new Queue(QUEUE, { embedded: true });

    const stateAfter = await queue.getJobState(jobId);
    expect(stateAfter).toBe('completed');

    // getJobs({state:'completed'}) sanity check — must also return the job
    const completed = queue.getJobs({ state: 'completed' });
    expect(completed.length).toBe(1);
    expect(String(completed[0].id)).toBe(jobId);

    // getJob() must return the job too
    const fetched = await queue.getJob(jobId);
    expect(fetched).not.toBeNull();
    expect(String(fetched!.id)).toBe(jobId);

    queue.obliterate();
    queue.close();
  });

  test('job.getState() on Job instance returns "completed" after restart', async () => {
    const QUEUE = 'issue-83-jobproxy';

    // Phase 1
    let queue = new Queue(QUEUE, { embedded: true });
    const worker = new Worker(QUEUE, async () => 'done', {
      embedded: true,
      removeOnComplete: false,
    });

    const added = await queue.add('task', { v: 1 }, { durable: true });
    const jobId = String(added.id);

    for (let i = 0; i < 50; i++) {
      const state = await queue.getJobState(jobId);
      if (state === 'completed') break;
      await Bun.sleep(50);
    }

    // Phase 2: restart
    await worker.close();
    queue.close();
    shutdownManager();
    await Bun.sleep(100);

    // Phase 3: fetch via getJobs, then call .getState() on returned Job
    Bun.env.DATA_PATH = DB_PATH;
    queue = new Queue(QUEUE, { embedded: true });

    const jobs = queue.getJobs({ state: 'completed' });
    expect(jobs.length).toBe(1);

    const state = await jobs[0].getState();
    expect(state).toBe('completed');

    queue.obliterate();
    queue.close();
  });

  test('failed/DLQ job state survives restart', async () => {
    const QUEUE = 'issue-83-failed';

    // Phase 1: add + fail a job (max 1 attempt → straight to DLQ)
    let queue = new Queue(QUEUE, { embedded: true });
    const worker = new Worker(
      QUEUE,
      async () => {
        throw new Error('intentional');
      },
      { embedded: true, removeOnFail: false }
    );

    const added = await queue.add('task', { v: 1 }, { attempts: 1, backoff: 0, durable: true });
    const jobId = String(added.id);

    for (let i = 0; i < 50; i++) {
      const state = await queue.getJobState(jobId);
      if (state === 'failed') break;
      await Bun.sleep(50);
    }

    expect(await queue.getJobState(jobId)).toBe('failed');

    // Phase 2: restart
    await worker.close();
    queue.close();
    shutdownManager();
    await Bun.sleep(100);

    // Phase 3: state must survive restart
    Bun.env.DATA_PATH = DB_PATH;
    queue = new Queue(QUEUE, { embedded: true });

    const stateAfter = await queue.getJobState(jobId);
    expect(stateAfter).toBe('failed');

    const fetched = await queue.getJob(jobId);
    expect(fetched).not.toBeNull();
    expect(String(fetched!.id)).toBe(jobId);

    queue.obliterate();
    queue.close();
  });

  test('retryDlq-ed job survives restart (regression: DLQ deleteJob must re-insert on retry)', async () => {
    const QUEUE = 'issue-83-retrydlq';

    // Phase 1: send job to DLQ
    let queue = new Queue(QUEUE, { embedded: true });
    const worker = new Worker(
      QUEUE,
      async () => {
        throw new Error('fail');
      },
      { embedded: true, removeOnFail: false }
    );

    const added = await queue.add('task', { v: 42 }, { attempts: 1, backoff: 0, durable: true });
    const jobId = String(added.id);

    for (let i = 0; i < 50; i++) {
      if ((await queue.getJobState(jobId)) === 'failed') break;
      await Bun.sleep(50);
    }

    await worker.close();

    // Retry from DLQ — pauses queue first so job stays waiting
    queue.pause();
    queue.retryDlq();

    // Job is now in queue (waiting) — verify BEFORE restart
    expect(await queue.getJobState(jobId)).toBe('waiting');

    queue.close();
    shutdownManager();
    await Bun.sleep(100);

    // Phase 2: restart — job must still exist and be recoverable
    Bun.env.DATA_PATH = DB_PATH;
    queue = new Queue(QUEUE, { embedded: true });

    const fetched = await queue.getJob(jobId);
    expect(fetched).not.toBeNull();
    expect(String(fetched!.id)).toBe(jobId);
    expect(await queue.getJobState(jobId)).toBe('waiting');

    queue.obliterate();
    queue.close();
  });
});
