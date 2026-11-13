/**
 * Long-running Jobs & Timeouts (Embedded Mode): job timeout and timeout with retry.
 *
 * Note: In embedded mode, job timeouts are handled by the QueueManager's
 * background tasks. A job timeout fires from its own timer.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';

describe('Long-running Jobs & Timeouts - Embedded', () => {
  afterEach(() => {
    shutdownManager();
  });

  test('1. job timeout — job exceeding timeout is failed', async () => {
    const queue = new Queue('lr-timeout-1', { embedded: true });
    queue.obliterate();

    let capturedJobId: string | null = null;
    let jobTimedOut = false;

    const worker = new Worker(
      'lr-timeout-1',
      async (job) => {
        capturedJobId = job.id;
        // Sleep long enough for the 5s timeout check to fire.
        // The job has timeout=500, so the background check will detect it
        // and call fail() on the job.
        await Bun.sleep(30000);
        return { done: true };
      },
      { embedded: true, concurrency: 1 }
    );

    // The server-side timeout handler removes the job from processing.
    // When the processor finishes, the ACK fails with "not found" which
    // emits an error event on the worker.
    worker.on('error', () => {
      jobTimedOut = true;
    });

    await queue.add('slow-job', { value: 1 }, { timeout: 500, attempts: 1 });

    // Wait for the timeout check to fire (runs every 5s).
    // After ~5s the check detects the job exceeded its 500ms timeout.
    for (let i = 0; i < 120; i++) {
      if (capturedJobId) {
        const state = await queue.getJobState(capturedJobId);
        // Once the timeout handler fires, the job is no longer 'active'
        if (state !== 'active' && state !== 'waiting') {
          jobTimedOut = true;
        }
      }
      if (jobTimedOut) break;
      await Bun.sleep(100);
    }

    await worker.close(true);

    expect(jobTimedOut).toBe(true);

    queue.close();
  }, 30000);

  test('6. timeout with retry — succeeds on 3rd attempt after 2 timeouts', async () => {
    const queue = new Queue('lr-retry-6', { embedded: true });
    queue.obliterate();

    let attemptCount = 0;
    let completed = false;
    let completedResult: unknown = null;

    // In embedded mode, when a job times out, the server-side timeout handler
    // fails the job and retries it. The same worker instance deduplicates by
    // jobId, so it won't re-process a job that is still in activeJobIds.
    // To handle this, we close and recreate the worker between retry cycles
    // so the retried job can be picked up cleanly.

    async function createAndRunWorker(): Promise<Worker> {
      const w = new Worker(
        'lr-retry-6',
        async () => {
          attemptCount++;
          if (attemptCount <= 2) {
            // Attempts 1 & 2: block until the 5s timeout check fires.
            await Bun.sleep(30000);
            return { done: false };
          }
          // 3rd attempt: complete quickly
          return { done: true, attempt: attemptCount };
        },
        { embedded: true, concurrency: 1 }
      );

      w.on('completed', (_job, result) => {
        completed = true;
        completedResult = result;
      });

      return w;
    }

    const job = await queue.add(
      'retry-timeout-job',
      { value: 1 },
      {
        timeout: 500,
        attempts: 3,
        backoff: 100,
      }
    );

    // Run through up to 3 worker cycles (one per attempt).
    // Each cycle: create worker -> wait for this attempt to time out -> force close.
    for (let cycle = 0; cycle < 3; cycle++) {
      if (completed) break;

      const attemptsBefore = attemptCount;
      const w = await createAndRunWorker();

      // Wait (at most 6s) for completion, or for this cycle's attempt to have
      // started and then left 'active' because its 500ms timeout fired.
      for (let i = 0; i < 60; i++) {
        if (completed) break;
        if (attemptCount > attemptsBefore && (await queue.getJobState(job.id)) !== 'active') break;
        await Bun.sleep(100);
      }

      // Force close the worker so the next cycle's worker can pick up
      // the retried job with a fresh activeJobIds set.
      await w.close(true);
    }

    expect(completed).toBe(true);
    expect((completedResult as { done: boolean; attempt: number }).done).toBe(true);
    expect((completedResult as { attempt: number }).attempt).toBe(3);

    queue.close();
  }, 30000);
});
