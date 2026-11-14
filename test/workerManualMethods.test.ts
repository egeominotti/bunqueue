/**
 * Worker Manual Methods Tests - BullMQ v5 Compatible
 * Tests for getNextJob, processJobManually, extendJobLocks
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Queue, Worker } from '../src/client';
import { shutdownManager } from '../src/client';
import { getSharedManager } from '../src/client/manager';

describe('Worker Manual Job Control - BullMQ v5', () => {
  let queue: Queue<{ value: number }>;

  beforeEach(() => {
    queue = new Queue('manual-test', { embedded: true });
    queue.obliterate();
  });

  afterEach(() => {
    queue.close();
    shutdownManager();
  });

  test('worker.getNextJob should fetch a job manually', async () => {
    await queue.add('test', { value: 42 });

    const worker = new Worker('manual-test', async () => ({ done: true }), {
      embedded: true,
      autorun: false,
    });

    const job = await worker.getNextJob();
    expect(job).toBeDefined();
    expect(job?.name).toBe('test');
    expect(job?.data).toEqual({ value: 42 });
    expect(job?.token).toBeString();

    await worker.close();
  });

  test('worker.getNextJob should return undefined when queue is empty', async () => {
    const worker = new Worker('manual-test', async () => ({ done: true }), {
      embedded: true,
      autorun: false,
    });

    const job = await worker.getNextJob();
    expect(job).toBeUndefined();

    await worker.close();
  });

  test('worker.processJobManually should process a job', async () => {
    await queue.add('test', { value: 42 });

    let processed = false;
    const worker = new Worker<{ value: number }>(
      'manual-test',
      async (job) => {
        processed = true;
        return { result: job.data.value * 2 };
      },
      { embedded: true, autorun: false }
    );

    const job = await worker.getNextJob();
    expect(job).toBeDefined();

    if (job) {
      await worker.processJobManually(job);
    }

    expect(processed).toBe(true);

    await worker.close();
  });

  test('worker.extendJobLocks should extend locks', async () => {
    const worker = new Worker('manual-test', async () => ({ done: true }), {
      embedded: true,
      autorun: false,
      useLocks: true,
      lockDuration: 1000,
    });
    try {
      const added = await queue.add('test', { value: 1 });
      const job = await worker.getNextJob();
      expect(job).toBeDefined();
      if (!job?.token) throw new Error('Expected a fetched job with a broker lock token');
      expect(String(job.id)).toBe(added.id);
      const manager = getSharedManager();
      const lock = manager.getLockInfo(job.id);
      expect(lock).not.toBeNull();
      if (!lock) throw new Error('Expected an active broker lease');
      const initial = { ...lock };
      expect(String(initial.token)).toBe(job.token);
      expect(await queue.getJobState(added.id)).toBe('active');

      expect(await worker.extendJobLocks([added.id], ['wrong-token'], 60000)).toBe(0);
      expect(manager.getLockInfo(job.id)).toEqual(initial);
      const before = Date.now();
      expect(await worker.extendJobLocks([added.id], [job.token], 60000)).toBe(1);
      const after = Date.now();
      const renewed = manager.getLockInfo(job.id);
      expect(String(renewed?.token)).toBe(job.token);
      expect(renewed?.renewalCount).toBe(1);
      expect(renewed?.expiresAt).toBeGreaterThan(initial.expiresAt);
      expect(renewed?.expiresAt).toBeGreaterThanOrEqual(before + 60000);
      expect(renewed?.expiresAt).toBeLessThanOrEqual(after + 60000);
      expect(await queue.getJobState(added.id)).toBe('active');

      await worker.processJobManually(job);
      expect(await queue.getJobState(added.id)).toBe('completed');
      expect(manager.getLockInfo(job.id)).toBeNull();
    } finally {
      await worker.close();
    }
  });
});

describe('Worker extendJobLocks validation', () => {
  test('extendJobLocks should throw if arrays have different lengths', async () => {
    const queue = new Queue('extend-test', { embedded: true });
    queue.obliterate();

    const worker = new Worker('extend-test', async () => ({ done: true }), {
      embedded: true,
      autorun: false,
    });

    await expect(worker.extendJobLocks(['job1', 'job2'], ['token1'], 1000)).rejects.toThrow(
      'jobIds and tokens arrays must have the same length'
    );

    await worker.close();
    queue.close();
    shutdownManager();
  });

  test('extendJobLocks should return 0 for empty arrays', async () => {
    const queue = new Queue('extend-empty-test', { embedded: true });
    queue.obliterate();

    const worker = new Worker('extend-empty-test', async () => ({ done: true }), {
      embedded: true,
      autorun: false,
    });

    const result = await worker.extendJobLocks([], [], 1000);
    expect(result).toBe(0);

    await worker.close();
    queue.close();
    shutdownManager();
  });
});
