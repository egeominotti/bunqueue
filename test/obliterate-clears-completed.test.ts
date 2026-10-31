/**
 * Regression: Queue.obliterate() leaves completed jobs in jobIndex/completedJobs.
 *
 * Repro for the pagination failure in scripts/embedded/test-query-operations.ts:
 * tests 1 & 2 complete jobs, test 3 adds a delayed job, then test 4 obliterates
 * and adds 10 fresh jobs expecting getJobs() to return exactly 10. It returned 12
 * because obliterate only cleared shard queues and left completed entries in the
 * global jobIndex.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';

const QUEUE = 'obliterate-cleanup';

describe('Queue.obliterate() fully purges completed jobs', () => {
  let queue: Queue<{ v: number }>;

  beforeEach(() => {
    queue = new Queue<{ v: number }>(QUEUE, { embedded: true });
    queue.obliterate();
  });

  afterEach(() => {
    queue.close();
    shutdownManager();
  });

  test('after completing a job + obliterate, getJobs() returns empty', async () => {
    await queue.add('j', { v: 1 });
    const worker = new Worker<{ v: number }>(QUEUE, async () => ({ done: true }), {
      concurrency: 1,
      embedded: true,
    });
    await Bun.sleep(300);
    await worker.close();

    const countsBeforeOb = queue.getJobCounts();
    expect(countsBeforeOb.completed).toBe(1);

    queue.obliterate();

    const all = queue.getJobs({ start: 0, end: 100 });
    expect(all).toHaveLength(0);

    const counts = queue.getJobCounts();
    expect(counts.completed).toBe(0);
  });

  test('obliterate purges an active (in-flight) job', async () => {
    // Hold a processor hostage so the job stays active while we obliterate.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });

    await queue.add('stuck', { v: 42 });
    const worker = new Worker<{ v: number }>(
      QUEUE,
      async () => {
        await held;
        return { done: true };
      },
      { concurrency: 1, embedded: true }
    );

    // Let pull promote the job to processing
    await Bun.sleep(200);
    const active = queue.getJobs({ start: 0, end: 100, state: 'active' });
    expect(active.length).toBe(1);

    // Obliterate while the job is active
    queue.obliterate();

    // The ghost must be gone from every index
    expect(queue.getJobs({ start: 0, end: 100 })).toHaveLength(0);
    expect(queue.getJobCounts().active).toBe(0);

    // Let the worker finish so close() can drain
    release();
    await Bun.sleep(100);
    await worker.close();
  });

  test('pagination reports exact count after obliterate + re-fill', async () => {
    // Completed leftover
    await queue.add('old', { v: 0 });
    const worker = new Worker<{ v: number }>(QUEUE, async () => ({}), {
      concurrency: 1,
      embedded: true,
    });
    await Bun.sleep(300);
    await worker.close();

    // Delayed leftover
    await queue.add('delayed', { v: 0 }, { delay: 60_000 });

    queue.obliterate();
    for (let i = 0; i < 10; i++) await queue.add(`j${i}`, { v: i });

    const all = queue.getJobs({ start: 0, end: 100 });
    expect(all).toHaveLength(10);
  });
});
