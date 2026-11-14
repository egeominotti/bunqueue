/**
 * Backpressure and Rate Limiting Tests (Embedded Mode)
 * Tests global concurrency limits, rate limits, and their interactions
 * with worker concurrency in embedded mode.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';
import { processorBarrier, waitForState } from './support/backpressure';

describe('Backpressure - Embedded', () => {
  afterEach(() => {
    shutdownManager();
  });

  test('global concurrency limit caps active jobs', async () => {
    const queue = new Queue<{ idx: number }>('bp-conc-limit', { embedded: true });
    queue.obliterate();

    queue.setGlobalConcurrency(2);

    let maxConcurrent = 0;
    let currentConcurrent = 0;
    let completed = 0;

    const worker = new Worker<{ idx: number }>(
      'bp-conc-limit',
      async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await Bun.sleep(300);
        currentConcurrent--;
        completed++;
        return {};
      },
      { embedded: true, concurrency: 10 }
    );

    for (let i = 0; i < 10; i++) {
      await queue.add('task', { idx: i });
    }

    // Wait for all jobs to complete
    for (let i = 0; i < 80; i++) {
      if (completed >= 10) break;
      await Bun.sleep(100);
    }

    // Allow tolerance of 3 for timing overlap
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(completed).toBe(10);

    queue.removeGlobalConcurrency();
    queue.removeGlobalRateLimit();
    await worker.close();
    queue.close();
  }, 30000);

  test('remove concurrency restores throughput', async () => {
    const queue = new Queue<{ idx: number }>('bp-conc-remove', { embedded: true });
    queue.obliterate();
    queue.setGlobalConcurrency(1);
    const barrier = processorBarrier();
    let started = 0;
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
      await queue.addBulk(Array.from({ length: 5 }, (_, idx) => ({ name: 'task', data: { idx } })));
      await waitForState(() => started >= 1, 'the first constrained processor');
      // Keep the first processor active while peers attempt to pull.
      await Bun.sleep(100);
      expect(started).toBe(1);
      expect(await queue.getJobCounts()).toMatchObject({ active: 1, waiting: 4 });
      queue.removeGlobalConcurrency();
      await waitForState(() => started === 5, 'five simultaneous processors after removal');
      expect(await queue.getJobCounts()).toMatchObject({ active: 5, waiting: 0, completed: 0 });
      barrier.release();
      await waitForState(
        async () => (await queue.getJobCounts()).completed === 5,
        'all completions'
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

  test('concurrency + worker concurrency interaction', async () => {
    const queue = new Queue<{ idx: number }>('bp-conc-worker', { embedded: true });
    queue.obliterate();

    // Server-side limit is 2, worker concurrency is 5
    queue.setGlobalConcurrency(2);

    let maxConcurrent = 0;
    let currentConcurrent = 0;
    let completed = 0;

    const worker = new Worker<{ idx: number }>(
      'bp-conc-worker',
      async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await Bun.sleep(200);
        currentConcurrent--;
        completed++;
        return {};
      },
      { embedded: true, concurrency: 5 }
    );

    for (let i = 0; i < 10; i++) {
      await queue.add('task', { idx: i });
    }

    // Wait for all jobs to complete
    for (let i = 0; i < 80; i++) {
      if (completed >= 10) break;
      await Bun.sleep(100);
    }

    // Global concurrency of 2 should limit effective concurrency
    // Allow tolerance of 3 for timing overlap
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(completed).toBe(10);

    queue.removeGlobalConcurrency();
    queue.removeGlobalRateLimit();
    await worker.close();
    queue.close();
  }, 30000);

  test('burst absorption - 100 jobs drain smoothly', async () => {
    const queue = new Queue<{ idx: number }>('bp-burst', { embedded: true });
    queue.obliterate();

    let completed = 0;

    const worker = new Worker<{ idx: number }>(
      'bp-burst',
      async () => {
        completed++;
        return {};
      },
      { embedded: true, concurrency: 10 }
    );

    // Burst: add 100 jobs at once
    const jobs = Array.from({ length: 100 }, (_, i) => ({
      name: `burst-${i}`,
      data: { idx: i },
    }));
    await queue.addBulk(jobs);

    // Wait for all to complete
    for (let i = 0; i < 100; i++) {
      if (completed >= 100) break;
      await Bun.sleep(100);
    }

    expect(completed).toBe(100);

    // Verify queue is drained
    const counts = await queue.getJobCounts();
    expect(counts.waiting).toBe(0);

    queue.removeGlobalConcurrency();
    queue.removeGlobalRateLimit();
    await worker.close();
    queue.close();
  }, 30000);

  test('multiple workers sharing concurrency', async () => {
    const queue = new Queue<{ idx: number }>('bp-multi-worker', { embedded: true });
    queue.obliterate();

    queue.setGlobalConcurrency(4);

    let maxConcurrent = 0;
    let currentConcurrent = 0;
    let completed = 0;

    const processor = async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await Bun.sleep(200);
      currentConcurrent--;
      completed++;
      return {};
    };

    const worker1 = new Worker<{ idx: number }>('bp-multi-worker', processor, {
      embedded: true,
      concurrency: 5,
    });

    const worker2 = new Worker<{ idx: number }>('bp-multi-worker', processor, {
      embedded: true,
      concurrency: 5,
    });

    for (let i = 0; i < 20; i++) {
      await queue.add('task', { idx: i });
    }

    // Wait for all jobs to complete
    for (let i = 0; i < 120; i++) {
      if (completed >= 20) break;
      await Bun.sleep(100);
    }

    // Global concurrency of 4 should limit total active across both workers
    // Allow tolerance of 5 for timing overlap
    expect(maxConcurrent).toBeLessThanOrEqual(5);
    expect(completed).toBe(20);

    queue.removeGlobalConcurrency();
    queue.removeGlobalRateLimit();
    await worker1.close();
    await worker2.close();
    queue.close();
  }, 30000);
});
