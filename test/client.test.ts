/**
 * Tests for bunqueue/client - BullMQ-style API
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';

describe('Queue', () => {
  let queue: Queue<{ value: number }>;

  beforeEach(() => {
    queue = new Queue('test-queue');
  });

  afterEach(() => {
    shutdownManager();
  });

  describe('add()', () => {
    it('should add a job and return job object', async () => {
      const job = await queue.add('task', { value: 42 });

      expect(job.id).toBeDefined();
      expect(job.name).toBe('task');
      expect(job.data.value).toBe(42);
      expect(job.queueName).toBe('test-queue');
      expect(job.attemptsMade).toBe(0);
    });

    it('should respect job options', async () => {
      const job = await queue.add(
        'task',
        { value: 1 },
        {
          priority: 10,
          delay: 1000,
        }
      );

      expect(job.id).toBeDefined();
    });
  });

  describe('getJob()', () => {
    it('should return job by ID', async () => {
      const added = await queue.add('task', { value: 99 });
      const fetched = await queue.getJob(added.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(added.id);
      expect(fetched!.data.value).toBe(99);
    });

    it('should return null for non-existent job', async () => {
      const fetched = await queue.getJob('non-existent-id');
      expect(fetched).toBeNull();
    });
  });

  describe('getJobCounts()', () => {
    it('should return job counts', async () => {
      await queue.add('task', { value: 1 });
      await queue.add('task', { value: 2 });

      const counts = await queue.getJobCounts();

      expect(counts.waiting).toBeGreaterThanOrEqual(2);
      expect(counts.active).toBeGreaterThanOrEqual(0);
    });
  });

  describe('pause() / resume()', () => {
    it('should pause and resume queue', async () => {
      await queue.pause();
      await queue.resume();
      // No error means success
      expect(true).toBe(true);
    });
  });

  describe('drain()', () => {
    it('should remove all waiting jobs', async () => {
      await queue.add('task', { value: 1 });
      await queue.add('task', { value: 2 });

      await queue.drain();

      const counts = await queue.getJobCounts();
      expect(counts.waiting).toBe(0);
    });
  });

  describe('obliterate()', () => {
    it('should remove all queue data', async () => {
      await queue.add('task', { value: 1 });
      await queue.obliterate();

      const counts = await queue.getJobCounts();
      expect(counts.waiting).toBe(0);
    });
  });
});

describe('Integration', () => {
  afterEach(() => {
    shutdownManager();
  });

  it('should handle full workflow', async () => {
    const queue = new Queue<{ email: string }>('integration');
    const processed: string[] = [];
    const progressUpdates: number[] = [];

    const worker = new Worker<{ email: string }>(
      'integration',
      async (job) => {
        await job.log('Starting');
        await job.updateProgress(50);
        processed.push(job.data.email);
        await job.updateProgress(100);
        return { sent: true };
      },
      { concurrency: 2 }
    );

    worker.on('progress', (_job, progress) => {
      progressUpdates.push(progress);
    });

    // Add jobs
    const jobs = await queue.addBulk([
      { name: 'send', data: { email: 'a@test.com' } },
      { name: 'send', data: { email: 'b@test.com' } },
    ]);

    expect(jobs).toHaveLength(2);

    // Wait for processing
    await Bun.sleep(300);

    expect(processed).toContain('a@test.com');
    expect(processed).toContain('b@test.com');
    expect(progressUpdates).toContain(50);
    expect(progressUpdates).toContain(100);

    // Verify counts
    const counts = await queue.getJobCounts();
    expect(counts.waiting).toBe(0);

    await worker.close();
  });

  it('should handle high throughput', async () => {
    const queue = new Queue('throughput');
    const JOBS = 1000;
    let completed = 0;

    const worker = new Worker(
      'throughput',
      async () => {
        return { ok: true };
      },
      { concurrency: 50 }
    );

    worker.on('completed', () => completed++);

    for (let i = 0; i < JOBS; i++) {
      await queue.add('task', { i });
    }

    // Wait for all jobs
    const start = Date.now();
    while (completed < JOBS && Date.now() - start < 10000) {
      await Bun.sleep(50);
    }

    expect(completed).toBe(JOBS);

    await worker.close();
  });
});
