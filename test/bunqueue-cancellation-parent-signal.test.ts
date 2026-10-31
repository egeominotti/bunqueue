/**
 * CancellationManager following the Worker's per-delivery signal (simple mode): the
 * parent's abort reaches the job's controller with the parent's reason, an already
 * aborted parent aborts at once, a pending grace timer is cleared, and unregister()
 * and destroyAll() detach the listener so a later parent abort touches nothing. An
 * aborted run starts no further in-process retry attempt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Bunqueue, shutdownManager } from '../src/client';
import { CancellationManager } from '../src/client/bunqueue/cancellation';

describe('CancellationManager parent signal', () => {
  test('a parent abort reaches the controller with its reason', () => {
    const manager = new CancellationManager();
    const parent = new AbortController();
    const controller = manager.register('job-1', parent.signal);
    expect(controller.signal.aborted).toBe(false);
    parent.abort(new Error('Job job-1 timed out after 200ms'));
    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error).message).toBe('Job job-1 timed out after 200ms');
    expect(manager.isCancelled('job-1')).toBe(true);
  });

  test('an already-aborted parent aborts the controller at once', () => {
    const manager = new CancellationManager();
    const parent = new AbortController();
    parent.abort('cancelled before start');
    const controller = manager.register('job-2', parent.signal);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('cancelled before start');
  });

  test('a parent abort clears a pending grace timer', async () => {
    const manager = new CancellationManager();
    const parent = new AbortController();
    const controller = manager.register('job-3', parent.signal);
    manager.cancel('job-3', 60_000);
    expect(controller.signal.aborted).toBe(false);
    parent.abort('worker');
    expect(controller.signal.reason).toBe('worker');
    // The grace timer must not fire later and must not keep the process alive.
    manager.unregister('job-3', controller);
    await Bun.sleep(5);
    expect(controller.signal.reason).toBe('worker');
  });

  test('unregister detaches the parent listener', () => {
    const manager = new CancellationManager();
    const parent = new AbortController();
    const controller = manager.register('job-4', parent.signal);
    manager.unregister('job-4', controller);
    parent.abort('late');
    expect(controller.signal.aborted).toBe(false);
  });

  test('destroyAll aborts with the default reason and detaches every parent', () => {
    const manager = new CancellationManager();
    const parents = [new AbortController(), new AbortController()];
    const controllers = parents.map((parent, index) =>
      manager.register(`job-${index}`, parent.signal)
    );
    manager.destroyAll();
    for (const controller of controllers) {
      expect(controller.signal.aborted).toBe(true);
      expect((controller.signal.reason as DOMException).name).toBe('AbortError');
    }
    for (const parent of parents) parent.abort('after destroy');
    for (const controller of controllers) {
      expect((controller.signal.reason as DOMException).name).toBe('AbortError');
    }
  });

  test('registrations without a parent keep the previous behaviour', () => {
    const manager = new CancellationManager();
    const controller = manager.register('job-5');
    manager.cancel('job-5');
    expect(controller.signal.aborted).toBe(true);
    expect(manager.getSignal('job-5')).toBe(controller.signal);
  });
});

describe('simple mode stops in-process retries after a Worker abort', () => {
  let app: Bunqueue<unknown, unknown> | null = null;
  afterEach(async () => {
    await app?.close(true);
    app = null;
    shutdownManager();
  });

  test('a job timeout during retry backoff runs the processor only once', async () => {
    let calls = 0;
    const instance: Bunqueue<unknown, unknown> = new Bunqueue(`cancel-retry-${process.pid}`, {
      embedded: true,
      retry: { maxAttempts: 5, delay: 400, strategy: 'fixed' },
      processor: async () => {
        calls++;
        throw new Error('transient');
      },
    });
    app = instance;
    const job = await instance.add('flaky', {}, { timeout: 200, attempts: 1 });
    const deadline = Date.now() + 3_000;
    let state = await instance.queue.getJobState(job.id);
    while (state !== 'failed' && Date.now() < deadline) {
      await Bun.sleep(20);
      state = await instance.queue.getJobState(job.id);
    }
    expect(state).toBe('failed');
    await Bun.sleep(600); // longer than one more backoff delay
    expect(calls).toBe(1);
  });
});
