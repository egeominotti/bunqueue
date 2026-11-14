/** Real token-bucket admission and removal with processors held active. */
import { afterEach, describe, expect, test } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';
import { processorBarrier, waitForState } from './support/backpressure';

describe('Backpressure rate limits - Embedded', () => {
  afterEach(() => {
    shutdownManager();
  });

  test('rate limit admits exactly the initial burst before refill', async () => {
    const queue = new Queue<{ idx: number }>('bp-rate-burst', { embedded: true });
    queue.obliterate();
    await queue.addBulk(Array.from({ length: 6 }, (_, idx) => ({ name: 'task', data: { idx } })));
    const barrier = processorBarrier();
    let started = 0;
    // The first refill is 20 seconds away, beyond this test's entire timeout.
    queue.setGlobalRateLimit(3, 60000);
    const worker = new Worker<{ idx: number }>(
      queue.name,
      async () => {
        started++;
        await barrier.promise;
        return {};
      },
      { embedded: true, concurrency: 6 }
    );
    try {
      await waitForState(() => started >= 3, 'the three initial admissions');
      await Bun.sleep(100);
      expect(started).toBe(3);
      expect(await queue.getJobCounts()).toMatchObject({ active: 3, waiting: 3, completed: 0 });
      queue.removeGlobalRateLimit();
      await waitForState(() => started === 6, 'the remaining admissions after removal');
      barrier.release();
      await waitForState(
        async () => (await queue.getJobCounts()).completed === 6,
        'six completions'
      );
    } finally {
      barrier.release();
      try {
        await worker.close();
      } finally {
        queue.close();
      }
    }
  }, 10000);

  test('rate limit throttles processing', async () => {
    const queue = new Queue<{ idx: number }>('bp-rate-limit', { embedded: true });
    queue.obliterate();
    await queue.addBulk(Array.from({ length: 6 }, (_, idx) => ({ name: 'task', data: { idx } })));
    const barrier = processorBarrier();
    const starts: number[] = [];
    // Three initial tokens, then one real token every 1000/3 ms (not a fixed window).
    const configuredAt = Date.now();
    queue.setGlobalRateLimit(3);
    const worker = new Worker<{ idx: number }>(
      queue.name,
      async () => {
        starts.push(Date.now());
        await barrier.promise;
        return {};
      },
      { embedded: true, concurrency: 6 }
    );
    try {
      // Read recorded admissions after refill; observer scheduling cannot change them.
      await waitForState(() => starts.length === 6, 'all three refilled tokens');
      expect(starts).toHaveLength(6);
      expect(starts[3] - configuredAt).toBeGreaterThanOrEqual(333);
      expect(starts[4] - configuredAt).toBeGreaterThanOrEqual(666);
      expect(starts[5] - configuredAt).toBeGreaterThanOrEqual(1000);
      expect(await queue.getJobCounts()).toMatchObject({ active: 6, waiting: 0, completed: 0 });
      barrier.release();
      await waitForState(
        async () => (await queue.getJobCounts()).completed === 6,
        'six completions'
      );
    } finally {
      barrier.release();
      try {
        await worker.close();
      } finally {
        queue.close();
      }
    }
  }, 10000);

  test('remove rate limit restores speed', async () => {
    const queue = new Queue<{ idx: number }>('bp-rate-remove', { embedded: true });
    queue.obliterate();
    await queue.addBulk(Array.from({ length: 5 }, (_, idx) => ({ name: 'task', data: { idx } })));
    const barrier = processorBarrier();
    let started = 0;
    // Keep the refill outside the bounded removal observation.
    queue.setGlobalRateLimit(1, 10000);
    const worker = new Worker<{ idx: number }>(
      queue.name,
      async () => {
        started++;
        await barrier.promise;
        return {};
      },
      { embedded: true, concurrency: 5 }
    );
    try {
      await waitForState(() => started >= 1, 'the initial rate-limited admission');
      await Bun.sleep(100);
      expect(started).toBe(1);
      expect(await queue.getJobCounts()).toMatchObject({ active: 1, waiting: 4 });
      queue.removeGlobalRateLimit();
      await waitForState(() => started === 5, 'all admissions before the next token', 1000);
      expect(await queue.getJobCounts()).toMatchObject({ active: 5, waiting: 0, completed: 0 });
      barrier.release();
      await waitForState(
        async () => (await queue.getJobCounts()).completed === 5,
        'five completions'
      );
    } finally {
      barrier.release();
      try {
        await worker.close();
      } finally {
        queue.close();
      }
    }
  }, 10000);
});
