/**
 * Tests for bunqueue/client - BullMQ-style API
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { Queue, Worker, QueueEvents, shutdownManager } from '../src/client';
import { waitForState } from './support/backpressure';

describe('Worker', () => {
  afterEach(() => {
    shutdownManager();
  });

  describe('events', () => {
    it('should emit active event', async () => {
      const queue = new Queue('events-active');
      let activeCount = 0;

      const worker = new Worker('events-active', async () => {
        await Bun.sleep(10);
      });

      worker.on('active', () => activeCount++);

      await queue.add('task', {});
      await Bun.sleep(100);

      expect(activeCount).toBeGreaterThanOrEqual(1);

      await worker.close();
    });

    it('should emit completed event with result', async () => {
      const queue = new Queue<{ val: number }>('events-completed');
      let completedResult: unknown = null;

      const worker = new Worker<{ val: number }>('events-completed', async (job) => {
        return { result: job.data.val * 2 };
      });

      worker.on('completed', (_job, result) => {
        completedResult = result;
      });

      await queue.add('task', { val: 21 });
      await Bun.sleep(150);

      expect(completedResult).toEqual({ result: 42 });

      await worker.close();
    });

    it('should emit failed event on error', async () => {
      const queue = new Queue('events-failed');
      let failedError: Error | null = null;

      const worker = new Worker('events-failed', async () => {
        throw new Error('Intentional error');
      });

      worker.on('failed', (_job, err) => {
        failedError = err;
      });

      await queue.add('task', {});
      await Bun.sleep(150);

      expect(failedError).not.toBeNull();
      expect(failedError!.message).toBe('Intentional error');

      await worker.close();
    });

    it('should emit progress event', async () => {
      const queue = new Queue('events-progress');
      const progressValues: number[] = [];

      const worker = new Worker('events-progress', async (job) => {
        await job.updateProgress(25);
        await job.updateProgress(50);
        await job.updateProgress(100);
        return {};
      });

      worker.on('progress', (_job, progress) => {
        progressValues.push(progress);
      });

      await queue.add('task', {});
      await Bun.sleep(150);

      expect(progressValues).toContain(25);
      expect(progressValues).toContain(50);
      expect(progressValues).toContain(100);

      await worker.close();
    });
  });
});

describe('Job methods', () => {
  afterEach(() => {
    shutdownManager();
  });

  describe('updateProgress()', () => {
    it('should update job progress', async () => {
      const queue = new Queue('job-progress');
      let lastProgress = 0;

      const worker = new Worker('job-progress', async (job) => {
        await job.updateProgress(50, 'Halfway');
        lastProgress = 50;
        return {};
      });

      worker.on('progress', (_job, progress) => {
        lastProgress = progress;
      });

      await queue.add('task', {});
      await Bun.sleep(150);

      expect(lastProgress).toBe(50);

      await worker.close();
    });
  });

  describe('log()', () => {
    it('should log messages', async () => {
      const queue = new Queue('job-log');
      let completedId: string | undefined;

      const worker = new Worker('job-log', async (job) => {
        await job.log('Step 1');
        await job.log('Step 2');
        return {};
      });
      worker.on('completed', (job) => {
        completedId = job.id;
      });

      try {
        const job = await queue.add('task', {});
        await waitForState(() => completedId === job.id, 'logged job completion');
        expect(await job.getState()).toBe('completed');
        expect(await queue.getJobLogs(job.id)).toEqual({
          logs: ['[info] Step 1', '[info] Step 2'],
          count: 2,
        });
      } finally {
        await worker.close(true);
        await queue.close();
      }
    });
  });
});

describe('QueueEvents', () => {
  afterEach(() => {
    shutdownManager();
  });

  it('should emit waiting event', async () => {
    const queue = new Queue('qe-waiting');
    const events = new QueueEvents('qe-waiting');
    const waitingIds: string[] = [];

    events.on('waiting', ({ jobId }) => waitingIds.push(jobId));

    try {
      await events.waitUntilReady();
      const job = await queue.add('task', {});
      await waitForState(() => waitingIds.length > 0, 'waiting event delivery');
      expect(waitingIds).toEqual([job.id]);
    } finally {
      events.close();
      await queue.close();
    }
  });
});
