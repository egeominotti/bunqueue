/**
 * Long-running Jobs & Timeouts (Embedded Mode): heartbeat keep-alive, stall
 * detection, concurrent long-running jobs and progress tracking.
 *
 * Note: In embedded mode, stall detection is handled by the QueueManager's
 * background tasks. The stall check runs every stallCheckMs (5s by default;
 * test 3 creates the shared manager with 100ms) using two-phase detection
 * (candidate -> confirmed).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';
import { getSharedManager } from '../src/client/manager';

describe('Long-running Jobs & Timeouts - Embedded', () => {
  afterEach(() => {
    shutdownManager();
  });

  test('2. heartbeat keeps job alive — long job with heartbeat completes', async () => {
    const queue = new Queue('lr-heartbeat-2', { embedded: true });
    queue.obliterate();

    // Configure stall detection with short interval
    queue.setStallConfig({
      stallInterval: 1000,
      maxStalls: 2,
      gracePeriod: 500,
    });

    let completed = false;
    let stalled = false;

    const worker = new Worker(
      'lr-heartbeat-2',
      async () => {
        // Long-running job (2s) -- heartbeat at 500ms prevents stalling
        await Bun.sleep(2000);
        return { done: true };
      },
      {
        embedded: true,
        concurrency: 1,
        heartbeatInterval: 500,
      }
    );

    worker.on('completed', () => {
      completed = true;
    });
    worker.on('stalled', () => {
      stalled = true;
    });

    await queue.add('long-job', { value: 1 });

    // Wait for the job to complete
    for (let i = 0; i < 100; i++) {
      if (completed) break;
      await Bun.sleep(100);
    }

    await worker.close();

    expect(completed).toBe(true);
    expect(stalled).toBe(false);

    queue.close();
  }, 30000);

  test('3. stall detection — job without heartbeat is detected as stalled', async () => {
    // A fresh shared manager with a 100ms stall sweep instead of the 5s default.
    shutdownManager();
    const manager = getSharedManager(undefined, { stallCheckMs: 100 });
    const queue = new Queue('lr-stall-3', { embedded: true });
    queue.obliterate();

    // Configure stall detection
    queue.setStallConfig({
      stallInterval: 1000,
      maxStalls: 2,
      gracePeriod: 500,
    });

    const stalledJobIds: string[] = [];

    // Subscribe to stall events directly from the QueueManager.
    // The two-phase stall detection marks candidates on one check cycle
    // and confirms them on the next.
    const unsubscribe = manager.subscribe((event) => {
      if (event.queue === 'lr-stall-3' && event.eventType === 'stalled') {
        stalledJobIds.push(String(event.jobId));
      }
    });

    const worker = new Worker(
      'lr-stall-3',
      async () => {
        // Block for a long time without heartbeat -- will be stalled.
        await Bun.sleep(25000);
        return { done: true };
      },
      {
        embedded: true,
        concurrency: 1,
        heartbeatInterval: 0, // Disable heartbeat
      }
    );

    await queue.add('stall-job', { value: 1 });

    // Wait for stall detection to fire: one sweep marks the job as a candidate,
    // the next confirms it as stalled.
    for (let i = 0; i < 200; i++) {
      if (stalledJobIds.length > 0) break;
      await Bun.sleep(100);
    }

    unsubscribe();
    await worker.close(true);

    // The job should have been detected as stalled at least once
    expect(stalledJobIds.length).toBeGreaterThan(0);

    queue.close();
  }, 30000);

  test('4. multiple long-running concurrent — 5 jobs in parallel', async () => {
    const queue = new Queue('lr-concurrent-4', { embedded: true });
    queue.obliterate();

    const completedIndices: number[] = [];

    const worker = new Worker(
      'lr-concurrent-4',
      async (job) => {
        const data = job.data as { index: number };
        // Each job takes ~1s
        await Bun.sleep(1000);
        completedIndices.push(data.index);
        return { index: data.index };
      },
      { embedded: true, concurrency: 5 }
    );

    const startTime = Date.now();

    // Push 5 jobs
    for (let i = 0; i < 5; i++) {
      await queue.add(`job-${i}`, { index: i });
    }

    // Wait for all 5 to complete
    for (let i = 0; i < 100; i++) {
      if (completedIndices.length >= 5) break;
      await Bun.sleep(100);
    }

    const elapsed = Date.now() - startTime;

    await worker.close();

    expect(completedIndices.length).toBe(5);
    // With concurrency:5, all 5 jobs should complete in roughly 1s (+ overhead)
    // rather than 5s (sequential). Allow up to 3s for CI overhead.
    expect(elapsed).toBeLessThan(3000);

    // Verify all indices are present
    const sorted = [...completedIndices].sort((a, b) => a - b);
    expect(sorted).toEqual([0, 1, 2, 3, 4]);

    queue.close();
  }, 30000);

  test('5. progress during long job — progress updates are recorded', async () => {
    const queue = new Queue('lr-progress-5', { embedded: true });
    queue.obliterate();

    const progressValues: number[] = [];
    let completed = false;

    const worker = new Worker(
      'lr-progress-5',
      async (job) => {
        // Simulate a 1s job with progress updates at 25%, 50%, 75%, 100%
        await Bun.sleep(250);
        await job.updateProgress(25);
        await Bun.sleep(250);
        await job.updateProgress(50);
        await Bun.sleep(250);
        await job.updateProgress(75);
        await Bun.sleep(250);
        await job.updateProgress(100);
        return { done: true };
      },
      { embedded: true, concurrency: 1 }
    );

    worker.on('progress', (_job, progress) => {
      progressValues.push(progress as number);
    });

    worker.on('completed', () => {
      completed = true;
    });

    await queue.add('progress-job', { value: 1 });

    // Wait for completion
    for (let i = 0; i < 100; i++) {
      if (completed) break;
      await Bun.sleep(100);
    }

    await worker.close();

    expect(completed).toBe(true);
    expect(progressValues).toEqual([25, 50, 75, 100]);

    queue.close();
  }, 30000);
});
