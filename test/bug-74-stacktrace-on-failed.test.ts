/**
 * Bug #74 - Stacktrace not included in `failed` worker event
 * https://github.com/egeominotti/bunqueue/issues/74
 *
 * When a job throws an Error, the `failed` event on the worker
 * should include the stack trace in `job.stacktrace`.
 * Currently `job.stacktrace` is always null/undefined.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';

describe('Bug #74 - Stacktrace on failed job', () => {
  let queue: Queue;
  let worker: Worker;

  afterEach(async () => {
    if (worker) await worker.close();
    if (queue) {
      queue.obliterate();
      queue.close();
    }
    shutdownManager();
  });

  test('job.stacktrace should contain error stack when job throws', async () => {
    queue = new Queue('bug-74-test', { embedded: true });
    queue.obliterate();

    const { promise, resolve } = Promise.withResolvers<{
      failedReason: string | undefined;
      stacktrace: string[] | null;
    }>();

    worker = new Worker(
      'bug-74-test',
      async () => {
        throw new Error('Something went wrong');
      },
      { embedded: true, autorun: false }
    );

    worker.on('failed', (job) => {
      resolve({
        failedReason: job?.failedReason,
        stacktrace: job?.stacktrace ?? null,
      });
    });

    worker.run();
    await queue.add('failing-job', { value: 1 });

    const result = await promise;

    expect(result.failedReason).toBe('Something went wrong');
    // This is the bug: stacktrace should NOT be null
    expect(result.stacktrace).not.toBeNull();
    expect(Array.isArray(result.stacktrace)).toBe(true);
    expect(result.stacktrace!.length).toBeGreaterThan(0);
    // The stack trace should contain the error message
    expect(result.stacktrace![0]).toContain('Something went wrong');
  });

  test('job.stacktrace should respect stackTraceLimit option', async () => {
    queue = new Queue('bug-74-limit-test', { embedded: true });
    queue.obliterate();

    const { promise, resolve } = Promise.withResolvers<string[] | null>();

    worker = new Worker(
      'bug-74-limit-test',
      async () => {
        // Create a deep call stack
        function a() {
          return b();
        }
        function b() {
          return c();
        }
        function c() {
          return d();
        }
        function d() {
          throw new Error('Deep error');
        }
        a();
      },
      { embedded: true, autorun: false }
    );

    worker.on('failed', (job) => {
      resolve(job?.stacktrace ?? null);
    });

    worker.run();
    await queue.add('deep-stack-job', { value: 1 }, { stackTraceLimit: 3 });

    const stacktrace = await promise;

    expect(stacktrace).not.toBeNull();
    expect(Array.isArray(stacktrace)).toBe(true);
    // Should have at most 3 lines due to stackTraceLimit
    expect(stacktrace!.length).toBeLessThanOrEqual(3);
  });
});
