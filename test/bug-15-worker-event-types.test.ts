/**
 * Bug #15 - No autocomplete on events of Worker
 * https://github.com/egeominotti/bunqueue/issues/15
 *
 * Worker extends EventEmitter without typed overloads, so
 * .on() and .once() have no IntelliSense for event names
 * or callback parameter types.
 *
 * These tests verify that Worker exposes typed event methods
 * similar to QueueEvents (which already has proper typing).
 */

import { describe, test, expect, expectTypeOf } from 'bun:test';
import type { EventEmitter } from 'events';
import { Worker } from '../src/client/worker';
import type { Job } from '../src/client/types';

describe('Bug #15 - Worker event type safety', () => {
  /**
   * This test verifies that the Worker class has typed on() overloads
   * for all known events. If the types are missing, TypeScript would
   * infer `any` for callback parameters (no IntelliSense).
   *
   * We test this at runtime by checking that on() returns `this`
   * (chainable) and that listeners are registered for each event name.
   */

  test('Worker.on should accept known event names and return this for chaining', () => {
    const worker = new Worker('test-events', async () => {}, {
      autorun: false,
    });

    // All known Worker events should be registerable
    const knownEvents = [
      'ready',
      'active',
      'completed',
      'failed',
      'progress',
      'stalled',
      'drained',
      'error',
      'cancelled',
      'closed',
    ];

    for (const event of knownEvents) {
      const result = (worker as EventEmitter).on(event, () => {});
      // on() should return `this` for chaining (EventEmitter contract)
      expect(result).toBe(worker);
    }

    // Verify listeners are actually registered
    for (const event of knownEvents) {
      expect(worker.listenerCount(event)).toBeGreaterThanOrEqual(1);
    }

    worker.close();
  });

  test('Worker.once should accept known event names', () => {
    const worker = new Worker('test-events-once', async () => {}, {
      autorun: false,
    });

    const knownEvents = [
      'ready',
      'active',
      'completed',
      'failed',
      'progress',
      'stalled',
      'drained',
      'error',
      'cancelled',
      'closed',
    ];

    for (const event of knownEvents) {
      const result = (worker as EventEmitter).once(event, () => {});
      expect(result).toBe(worker);
    }

    worker.close();
  });

  test('Worker event callbacks should receive correct parameter types', () => {
    // This test documents the expected callback signatures. The listeners carry no
    // parameter annotations, so the typed on() overloads infer them; expectTypeOf
    // makes `bun check` fail if an overload is missing or degrades to `any`.
    const worker = new Worker<{ msg: string }, { ok: boolean }>(
      'test-typed-events',
      async () => ({ ok: true }),
      { autorun: false }
    );

    let activeJob = null as Job<{ msg: string }> | null;
    let completedResult = null as { ok: boolean } | null;
    let failedError = null as Error | null;
    let progressValue = null as number | null;
    let stalledId = null as string | null;
    let cancelledInfo = null as { jobId: string; reason: string } | null;

    // 'active' should receive (job: Job<T>)
    worker.on('active', (job) => {
      expectTypeOf(job).toEqualTypeOf<Job<{ msg: string }>>();
      activeJob = job;
    });

    // 'completed' should receive (job: Job<T>, result: R)
    worker.on('completed', (job, result) => {
      expectTypeOf(job).toEqualTypeOf<Job<{ msg: string }>>();
      expectTypeOf(result).toEqualTypeOf<{ ok: boolean }>();
      completedResult = result;
    });

    // 'failed' should receive (job: Job<T>, error: Error)
    worker.on('failed', (job, error) => {
      expectTypeOf(job).toEqualTypeOf<Job<{ msg: string }>>();
      expectTypeOf(error).toEqualTypeOf<Error>();
      failedError = error;
    });

    // 'progress' should receive (job: Job<T> | null, progress: number)
    worker.on('progress', (job, progress) => {
      expectTypeOf(job).toEqualTypeOf<Job<{ msg: string }> | null>();
      expectTypeOf(progress).toEqualTypeOf<number>();
      progressValue = progress;
    });

    // 'stalled' should receive (jobId: string, reason: string)
    worker.on('stalled', (jobId, reason) => {
      expectTypeOf(jobId).toEqualTypeOf<string>();
      expectTypeOf(reason).toEqualTypeOf<string>();
      stalledId = jobId;
    });

    // 'cancelled' should receive ({ jobId: string, reason: string })
    worker.on('cancelled', (info) => {
      expectTypeOf(info).toEqualTypeOf<{ jobId: string; reason: string }>();
      cancelledInfo = info;
    });

    // Verify listeners were registered (runtime check)
    expect(worker.listenerCount('active')).toBe(1);
    expect(worker.listenerCount('completed')).toBe(1);
    expect(worker.listenerCount('failed')).toBe(1);
    expect(worker.listenerCount('progress')).toBe(1);
    expect(worker.listenerCount('stalled')).toBe(1);
    expect(worker.listenerCount('cancelled')).toBe(1);

    // Nothing is delivered before an event is emitted.
    expect(activeJob).toBeNull();
    expect(completedResult).toBeNull();
    expect(failedError).toBeNull();
    expect(progressValue).toBeNull();
    expect(stalledId).toBeNull();
    expect(cancelledInfo).toBeNull();

    // Emit each event with the documented argument list (the runtime emitters are
    // exercised end to end in test/docs-worker-guide/events.test.ts) and verify each
    // listener reads the documented argument position.
    const job = { id: 'job-15', name: 'typed', data: { msg: 'hi' } } as Job<{ msg: string }>;
    const error = new Error('boom');
    worker.emit('active', job);
    worker.emit('completed', job, { ok: true });
    worker.emit('failed', job, error);
    worker.emit('progress', job, 42);
    worker.emit('stalled', 'job-15', 'active');
    worker.emit('cancelled', { jobId: 'job-15', reason: 'stop' });

    expect(activeJob).toBe(job);
    expect(completedResult).toEqual({ ok: true });
    expect(failedError).toBe(error);
    expect(progressValue).toBe(42);
    expect(stalledId).toBe('job-15');
    expect(cancelledInfo).toEqual({ jobId: 'job-15', reason: 'stop' });

    worker.close();
  });
});
