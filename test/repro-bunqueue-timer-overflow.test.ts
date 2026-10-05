/**
 * Repro: Simple Mode timers whose delay lies outside the runtime's timer range.
 *
 * Bun and Node arm a timer whose delay is NaN, Infinity, negative or above 2^31 - 1 ms
 * after about 1 ms. The fake runtime (test/shared-timers-support.ts) records every such
 * delay in `invalid` and, like the real runtime, fires it after 1 ms. Each case asserts
 * that no native timer receives an out-of-range delay and that the feature waits
 * exactly as long as configured: a 30-day wait is neither early nor late.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PriorityAger } from '../src/client/bunqueue/aging';
import { BatchAccumulator } from '../src/client/bunqueue/batch';
import { CancellationManager } from '../src/client/bunqueue/cancellation';
import { WorkerCircuitBreaker } from '../src/client/bunqueue/circuitBreaker';
import type { Queue } from '../src/client/queue/queue';
import type { FlowJobData, Job } from '../src/client/types';
import type { Worker } from '../src/client/worker/worker';
import { installFakeTimers, restoreTimers } from './shared-timers-support';

const DAY = 86_400_000;
const LONG = 30 * DAY; // above the 2^31 - 1 ms (about 24.8 days) native limit
let fake: ReturnType<typeof installFakeTimers>;

beforeEach(() => {
  fake = installFakeTimers();
});

afterEach(() => {
  restoreTimers();
});

function job(id: string): Job<FlowJobData> {
  return { id, name: 'row', data: {} } as unknown as Job<FlowJobData>;
}

function fakeWorker() {
  const state = { paused: false, resumes: 0 };
  const worker = {
    pause: () => {
      state.paused = true;
    },
    resume: () => {
      state.paused = false;
      state.resumes++;
    },
    isPaused: () => state.paused,
  } as unknown as Worker;
  return { worker, state };
}

function fakeQueue(onWaitingQuery: () => Promise<unknown[]> = async () => []) {
  const calls = { waiting: 0 };
  const queue = {
    getWaitingAsync: () => {
      calls.waiting++;
      return onWaitingQuery();
    },
    getJobsAsync: async () => [],
    changeJobPriority: async () => {},
  } as unknown as Queue<unknown>;
  return { queue, calls };
}

describe('batch.timeout', () => {
  test('a partial batch waits its whole timeout beyond the timer limit', () => {
    const flushed: number[] = [];
    const batch = new BatchAccumulator<FlowJobData, null>({
      size: 10,
      timeout: LONG,
      processor: async (jobs) => {
        flushed.push(jobs.length);
        return jobs.map(() => null);
      },
    });
    void batch.buildProcessor()(job('a'));

    expect(fake.invalid).toEqual([]);
    fake.advance(10);
    expect(flushed).toEqual([]);
    fake.advance(LONG - 11);
    expect(flushed).toEqual([]);
    fake.advance(1);
    expect(flushed).toEqual([1]);
    expect(fake.invalid).toEqual([]);
  });

  test('destroy() flushes a long partial batch and leaves no timer armed', () => {
    const flushed: number[] = [];
    const batch = new BatchAccumulator<FlowJobData, null>({
      size: 10,
      timeout: LONG,
      processor: async (jobs) => {
        flushed.push(jobs.length);
        return jobs.map(() => null);
      },
    });
    void batch.buildProcessor()(job('a'));
    fake.advance(DAY);
    batch.destroy();
    expect(flushed).toEqual([1]);
    expect(fake.pending.size).toBe(0);
    expect(fake.invalid).toEqual([]);
  });
});

describe('cancel(jobId, gracePeriodMs)', () => {
  test('a grace period beyond the timer limit aborts at its deadline', () => {
    const manager = new CancellationManager();
    const controller = manager.register('job');
    manager.cancel('job', LONG);

    expect(fake.invalid).toEqual([]);
    fake.advance(10);
    expect(controller.signal.aborted).toBe(false);
    fake.advance(LONG - 11);
    expect(controller.signal.aborted).toBe(false);
    fake.advance(1);
    expect(controller.signal.aborted).toBe(true);
  });

  test('a shorter grace still advances a long one, and unregister clears it', () => {
    const manager = new CancellationManager();
    const first = manager.register('first');
    manager.cancel('first', LONG);
    manager.cancel('first', 1_000);
    fake.advance(1_000);
    expect(first.signal.aborted).toBe(true);

    const second = manager.register('second');
    manager.cancel('second', LONG);
    manager.unregister('second', second);
    expect(fake.pending.size).toBe(0);
    expect(fake.invalid).toEqual([]);
  });
});

describe('circuitBreaker.resetTimeout', () => {
  test('a reset timeout beyond the timer limit keeps the circuit open until it elapses', () => {
    const { worker, state } = fakeWorker();
    const breaker = new WorkerCircuitBreaker({ threshold: 1, resetTimeout: LONG }, worker);
    breaker.onFailure();
    expect(breaker.currentState).toBe('open');
    expect(state.paused).toBe(true);

    expect(fake.invalid).toEqual([]);
    fake.advance(10);
    expect(breaker.currentState).toBe('open');
    fake.advance(LONG - 11);
    expect(breaker.currentState).toBe('open');
    expect(state.paused).toBe(true);
    fake.advance(1);
    expect(breaker.currentState).toBe('half-open');
    expect(state.paused).toBe(false);
  });

  test('resetTimeout: Infinity stays open until resetCircuit()', () => {
    const { worker, state } = fakeWorker();
    const breaker = new WorkerCircuitBreaker({ threshold: 1, resetTimeout: Infinity }, worker);
    breaker.onFailure();

    expect(fake.invalid).toEqual([]);
    fake.advance(365 * DAY);
    expect(breaker.currentState).toBe('open');
    expect(state.paused).toBe(true);
    expect(fake.pending.size).toBe(0);

    breaker.reset();
    expect(breaker.currentState).toBe('closed');
    expect(state.paused).toBe(false);
  });

  test('destroy() clears a long reset timer', () => {
    const { worker } = fakeWorker();
    const breaker = new WorkerCircuitBreaker({ threshold: 1, resetTimeout: LONG }, worker);
    breaker.onFailure();
    fake.advance(DAY);
    breaker.destroy();
    expect(fake.pending.size).toBe(0);
    fake.advance(LONG);
    expect(breaker.currentState).toBe('open');
  });
});

/**
 * The fake runtime fires timers synchronously; the real event loop drains microtasks
 * between two timer callbacks, which lets a tick whose queries already resolved finish
 * before the next firing (aging runs at most one tick at a time).
 */
async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

describe('priorityAging.interval', () => {
  test('an interval beyond the timer limit ticks once per interval', async () => {
    const { queue, calls } = fakeQueue();
    const ager = new PriorityAger({ interval: LONG }, queue);
    ager.start();
    try {
      expect(fake.invalid).toEqual([]);
      fake.advance(10);
      expect(calls.waiting).toBe(0);
      fake.advance(LONG - 11);
      expect(calls.waiting).toBe(0);
      fake.advance(1);
      expect(calls.waiting).toBe(1);
      await drainMicrotasks();
      fake.advance(LONG);
      expect(calls.waiting).toBe(2);
    } finally {
      ager.destroy();
    }
    expect(fake.pending.size).toBe(0);
    expect(fake.invalid).toEqual([]);
  });

  test('a tick whose job query fails is skipped without an unhandled rejection', async () => {
    const { queue, calls } = fakeQueue(async () => {
      throw new Error('transient query failure');
    });
    const ager = new PriorityAger({ interval: 1_000 }, queue);
    ager.start();
    try {
      fake.advance(1_000);
      await drainMicrotasks();
      fake.advance(1_000);
      // A rejected tick surfaces here as an unhandled error that fails this test.
      await Bun.sleep(5);
      expect(calls.waiting).toBe(2);
    } finally {
      ager.destroy();
    }
  });
});
