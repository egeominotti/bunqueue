/**
 * Legacy entry: Simple Mode (Bunqueue) timers, backoff arithmetic and validation.
 *
 * The 0.1.x Simple Mode port armed raw timers with option values, so a delay above
 * 2^31 - 1 ms fired after about 1 ms, an Infinity "stay open" breaker half-opened at
 * once, a zero rate-limit window spun, and the backoff formulas overflowed to Infinity
 * or NaN. These tests pin the main client's semantics; option validation is in
 * legacy-simple-mode-validation.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { PriorityAger } from '../src/bunqueue/aging.js';
import { BatchAccumulator } from '../src/bunqueue/batch.js';
import { CancellationManager } from '../src/bunqueue/cancellation.js';
import { WorkerCircuitBreaker } from '../src/bunqueue/circuit-breaker.js';
import { RateGate } from '../src/bunqueue/rate-gate.js';
import { calculateBackoff, executeWithRetry } from '../src/bunqueue/retry.js';
import type { Job } from '../src/job.js';
import type { Queue } from '../src/queue.js';
import type { WorkerBase } from '../src/worker-base.js';

const BEYOND_TIMER_LIMIT = 2 ** 31 + 1_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const boom = new Error('boom');

describe('retry backoff arithmetic', () => {
  test('exponential, jitter and fibonacci saturate instead of overflowing', () => {
    for (const strategy of ['exponential', 'fibonacci'] as const) {
      expect(calculateBackoff(strategy, 1_600, 1000, boom, {})).toBe(Number.MAX_SAFE_INTEGER);
    }
    // Jitter scales the saturated delay by 0.5..1.5 and saturates again.
    const jittered = calculateBackoff('jitter', 1_600, 1000, boom, {});
    expect(Number.isFinite(jittered)).toBe(true);
    expect(jittered).toBeGreaterThanOrEqual(Math.floor(Number.MAX_SAFE_INTEGER / 2));
    expect(jittered).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });

  test('a zero base delay stays 0 at any attempt (never 0 * Infinity = NaN)', () => {
    for (const strategy of ['exponential', 'jitter', 'fibonacci'] as const) {
      expect(calculateBackoff(strategy, 1_600, 0, boom, {})).toBe(0);
    }
  });

  test('the documented formulas are unchanged below saturation', () => {
    expect(calculateBackoff('exponential', 4, 100, boom, {})).toBe(800);
    expect(calculateBackoff('fibonacci', 5, 100, boom, {})).toBe(800);
    expect(calculateBackoff('fixed', 9, 250, boom, {})).toBe(250);
  });

  test('an infinite or non-numeric customBackoff result fails the job with the cause', async () => {
    // NaN, negative, undefined and numeric strings keep 0.2.2's result (a retry at once
    // or after the number): see legacy-compat-simple-mode.test.ts.
    for (const [bad, ErrorType] of [
      [Number.POSITIVE_INFINITY, RangeError],
      ['soon', TypeError],
    ] as const) {
      let calls = 0;
      const run = executeWithRetry(
        async () => {
          calls += 1;
          throw boom;
        },
        { maxAttempts: 3, strategy: 'custom', customBackoff: () => bad as number }
      );
      const error = await run.catch((caught: unknown) => caught as Error);
      expect(error).toBeInstanceOf(ErrorType);
      expect(error.message).toContain('the delay returned by retry.customBackoff');
      expect(error.cause).toBe(boom);
      expect(calls).toBe(1);
    }
  });

  test('a retry delay beyond the timer limit waits, and an abort cancels the wait', async () => {
    const controller = new AbortController();
    let calls = 0;
    const run = executeWithRetry(
      async () => {
        calls += 1;
        throw boom;
      },
      { maxAttempts: 2, strategy: 'fixed', delay: BEYOND_TIMER_LIMIT },
      controller.signal
    );
    const settled = run.catch((caught: unknown) => caught as Error);
    await sleep(60);
    expect(calls).toBe(1);
    controller.abort();
    expect((await settled).message).toBe('Job cancelled');
    expect(calls).toBe(1);
  });
});

describe('Simple Mode timers', () => {
  function fakeWorker() {
    const events: string[] = [];
    const worker = {
      paused: false,
      pause() {
        this.paused = true;
        events.push('pause');
      },
      resume() {
        this.paused = false;
        events.push('resume');
      },
      isPaused() {
        return this.paused;
      },
    };
    return { worker: worker as unknown as WorkerBase, events };
  }

  test('a circuit breaker resetTimeout beyond the timer limit stays open', async () => {
    for (const resetTimeout of [BEYOND_TIMER_LIMIT, Number.POSITIVE_INFINITY]) {
      const { worker, events } = fakeWorker();
      const breaker = new WorkerCircuitBreaker({ threshold: 1, resetTimeout }, worker);
      breaker.onFailure();
      await sleep(40);
      expect(breaker.currentState).toBe('open');
      expect(events).toEqual(['pause']);
      breaker.destroy();
    }
  });

  test('a short resetTimeout still half-opens', async () => {
    const { worker, events } = fakeWorker();
    const breaker = new WorkerCircuitBreaker({ threshold: 1, resetTimeout: 5 }, worker);
    breaker.onFailure();
    await sleep(60);
    expect(breaker.currentState).toBe('half-open');
    expect(events).toEqual(['pause', 'resume']);
    breaker.destroy();
  });

  test('a batch timeout beyond the timer limit does not flush a partial batch at once', async () => {
    const flushed: number[] = [];
    const batch = new BatchAccumulator<unknown, string>({
      size: 10,
      timeout: BEYOND_TIMER_LIMIT,
      processor: async (jobs) => {
        flushed.push(jobs.length);
        return jobs.map(() => 'ok');
      },
    });
    const pending = batch.buildProcessor()({ id: '1' } as unknown as Job<unknown>);
    await sleep(40);
    expect(flushed).toEqual([]);
    batch.destroy();
    expect(await pending).toBe('ok');
    expect(flushed).toEqual([1]);
  });

  test('a cancel grace period beyond the timer limit does not abort at once', async () => {
    const manager = new CancellationManager();
    const controller = manager.register('job-1');
    manager.cancel('job-1', BEYOND_TIMER_LIMIT);
    await sleep(40);
    expect(controller.signal.aborted).toBe(false);
    manager.destroyAll();
    expect(controller.signal.aborted).toBe(true);
  });

  test('priority aging: no tick before a long interval, one tick in flight at most', async () => {
    let scans = 0;
    const never = new Promise<never>(() => {});
    const queue = {
      getJobs: () => {
        scans += 1;
        return never;
      },
    } as unknown as Queue;
    const slow = new PriorityAger({ interval: BEYOND_TIMER_LIMIT }, queue);
    slow.start();
    await sleep(40);
    expect(scans).toBe(0);
    slow.destroy();

    const busy = new PriorityAger({ interval: 5 }, queue);
    busy.start();
    await sleep(80);
    // Both state scans of the first tick; every later firing finds it in flight.
    expect(scans).toBe(2);
    busy.destroy();
  });

  test('priority aging: a failing scan is skipped, not an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const queue = { getJobs: async () => Promise.reject(new Error('down')) } as unknown as Queue;
    const ager = new PriorityAger({ interval: 5 }, queue);
    try {
      ager.start();
      await sleep(60);
      expect(unhandled).toEqual([]);
    } finally {
      ager.destroy();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('the rate gate sleeps through a long window instead of polling every millisecond', async () => {
    const gate = new RateGate({ max: 1, duration: BEYOND_TIMER_LIMIT });
    await gate.acquire('');
    const original = globalThis.setTimeout;
    let armed = 0;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      armed += 1;
      return original(...args);
    }) as typeof setTimeout;
    try {
      void gate.acquire('');
      await new Promise((resolve) => original(resolve, 60));
    } finally {
      globalThis.setTimeout = original;
    }
    expect(armed).toBeLessThanOrEqual(2);
  });
});
