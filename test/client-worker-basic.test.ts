/**
 * Tests for bunqueue/client - BullMQ-style API
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';
import { processorBarrier, waitForState } from './support/backpressure';

describe('Worker', () => {
  afterEach(() => {
    shutdownManager();
  });

  describe('processing', () => {
    it('should process jobs', async () => {
      const queue = new Queue<{ x: number }>('worker-test');
      const results: number[] = [];

      const worker = new Worker<{ x: number }>('worker-test', async (job) => {
        results.push(job.data.x);
        return { doubled: job.data.x * 2 };
      });

      await queue.add('calc', { x: 5 });
      await queue.add('calc', { x: 10 });

      await Bun.sleep(200);

      expect(results).toContain(5);
      expect(results).toContain(10);

      await worker.close();
    });

    it('should respect concurrency', async () => {
      const queue = new Queue<{ id: number }>('concurrency-test');
      let concurrent = 0;
      let maxConcurrent = 0;

      const worker = new Worker(
        'concurrency-test',
        async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await Bun.sleep(50);
          concurrent--;
        },
        { concurrency: 3 }
      );

      for (let i = 0; i < 9; i++) {
        await queue.add('task', { id: i });
      }

      await Bun.sleep(500);

      expect(maxConcurrent).toBeLessThanOrEqual(3);
      expect(maxConcurrent).toBeGreaterThanOrEqual(1);

      await worker.close();
    });
  });

  describe('pause() / resume()', () => {
    it('should pause and resume processing', async () => {
      const queue = new Queue('pause-test');
      let processed = 0;

      const worker = new Worker('pause-test', async () => {
        processed++;
      });

      await queue.add('task', {});
      await Bun.sleep(100);

      const beforePause = processed;
      worker.pause();

      await queue.add('task', {});
      await Bun.sleep(100);

      expect(processed).toBe(beforePause);

      worker.resume();
      await Bun.sleep(100);

      expect(processed).toBeGreaterThan(beforePause);

      await worker.close();
    });
  });

  describe('close()', () => {
    it('should wait for active jobs on graceful close', async () => {
      const queue = new Queue('close-test');
      let completed = false;

      const worker = new Worker('close-test', async () => {
        await Bun.sleep(50);
        completed = true;
      });

      await queue.add('task', {});
      await Bun.sleep(100); // Wait for job to start

      await worker.close();

      expect(completed).toBe(true);
    });

    it('should close immediately with force=true', async () => {
      const queue = new Queue('force-close');
      const barrier = processorBarrier();
      let started = false;
      let finished = false;
      let closed = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const worker = new Worker('force-close', async () => {
        started = true;
        await barrier.promise;
        finished = true;
      });
      worker.on('closed', () => {
        closed = true;
      });

      try {
        await queue.add('task', {});
        await waitForState(() => started, 'force-close processor start');
        await Promise.race([
          worker.close(true),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              reject(new Error('Forced close waited for the blocked processor'));
            }, 3000);
          }),
        ]);
        expect(closed).toBe(true);
        expect(finished).toBe(false);
      } finally {
        clearTimeout(timeout);
        barrier.release();
        await worker.close(true);
        await waitForState(() => !started || finished, 'force-close processor cleanup');
        await queue.close();
      }
    });
  });
});
