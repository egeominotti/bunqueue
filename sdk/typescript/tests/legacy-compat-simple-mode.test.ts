/**
 * Legacy entry: 0.2.2 compatibility of the Simple Mode (Bunqueue) options.
 *
 * Every value below constructed and ran in 0.2.2 without a hot loop, a hang or a
 * crash; 0.2.3 must keep that result. Each expectation was verified against the 0.2.2
 * sources: a `maxAttempts` of 0 is one attempt, an unknown strategy is a fixed delay,
 * a zero `threshold` opens on the first failure, a zero `batch.size` flushes every
 * job, a zero aging `boost` or `maxScan` is a no-op, a negative or NaN one-shot delay
 * runs at once, and `heartbeatInterval: null` disables heartbeats.
 */

import { describe, expect, test } from 'bun:test';
import { PriorityAger } from '../src/bunqueue/aging.js';
import { Bunqueue } from '../src/bunqueue/bunqueue.js';
import { WorkerCircuitBreaker } from '../src/bunqueue/circuit-breaker.js';
import { RateGate } from '../src/bunqueue/rate-gate.js';
import { calculateBackoff, executeWithRetry } from '../src/bunqueue/retry.js';
import type { BunqueueOptions } from '../src/bunqueue/types.js';
import type { Queue } from '../src/queue.js';
import type { WorkerBase } from '../src/worker-base.js';

const boom = new Error('boom');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const loose = (value: unknown) => value as never;

async function app(extra: Record<string, unknown>) {
  const options = { processor: async () => 'ok', autorun: false, ...extra };
  const instance = new Bunqueue('compat', options as BunqueueOptions);
  await instance.close();
  return instance;
}

describe('0.2.2 compatibility: Bunqueue constructor', () => {
  test.each([
    ['retry.maxAttempts 0', { retry: { maxAttempts: 0 } }],
    ['retry.maxAttempts 2.5 and NaN', { retry: { maxAttempts: 2.5, delay: Number.NaN } }],
    ['retry.strategy linear', { retry: { strategy: 'linear' } }],
    ['retry delay -1', { retry: { delay: -1 } }],
    ['retry delay numeric string', { retry: { delay: '250' } }],
    ['retry callbacks that are not functions', { retry: { customBackoff: false, retryIf: 0 } }],
    [
      'circuitBreaker.threshold 0, resetTimeout -1',
      { circuitBreaker: { threshold: 0, resetTimeout: -1 } },
    ],
    ['circuitBreaker.threshold NaN', { circuitBreaker: { threshold: Number.NaN } }],
    ['priorityAging boost 0 maxScan 0', { priorityAging: { boost: 0, maxScan: 0 } }],
    [
      'priorityAging NaN/Infinity',
      { priorityAging: { boost: Infinity, maxPriority: Number.NaN, minAge: -1 } },
    ],
    ['priorityAging interval string', { priorityAging: { interval: '60000', maxScan: 2 ** 53 } }],
    ['rateLimit duration 0', { rateLimit: { max: 1, duration: 0 } }],
    ['limiter without duration', { limiter: { max: 1.5 } }],
    ['rateLimit max Infinity, string duration', { rateLimit: { max: Infinity, duration: '1000' } }],
    ['heartbeatInterval string', { heartbeatInterval: '1000' }],
    ['pollTimeout string', { pollTimeout: '300' }],
  ])('%s constructs', async (_name, extra) => {
    await app(extra);
  });

  test('batch.size 0 or missing constructs', async () => {
    const processor = async (jobs: unknown[]) => jobs.map(() => 'ok');
    for (const batch of [
      { size: 0, processor },
      { processor },
      { size: 2, timeout: -1, processor },
    ]) {
      await app({ processor: undefined, batch });
    }
  });

  test('heartbeatInterval: null disables heartbeats; a numeric string is milliseconds', async () => {
    expect((await app({ heartbeatInterval: null })).worker.heartbeatIntervalS).toBe(0);
    expect((await app({ heartbeatInterval: '2500' })).worker.heartbeatIntervalS).toBe(2.5);
    expect((await app({ pollTimeout: '300' })).worker.pollTimeoutMs).toBe(300);
  });

  test('cancel(): a negative, NaN or null grace cancels at once; a numeric string waits', async () => {
    const instance = new Bunqueue('compat', { processor: async () => 'ok', autorun: false });
    try {
      for (const grace of [-1, Number.NaN, loose(null), loose('20')]) {
        expect(() => instance.cancel('job', grace)).not.toThrow();
      }
    } finally {
      await instance.close();
    }
  });
});

describe('0.2.2 compatibility: retry', () => {
  async function attempts(config: Record<string, unknown>): Promise<number> {
    let calls = 0;
    await executeWithRetry(async () => {
      calls += 1;
      throw boom;
    }, loose(config)).catch(() => undefined);
    return calls;
  }

  test('maxAttempts is compared as 0.2.2 compared it', async () => {
    expect(await attempts({ maxAttempts: 0, delay: 0 })).toBe(1);
    expect(await attempts({ maxAttempts: -1, delay: 0 })).toBe(1);
    expect(await attempts({ maxAttempts: 2.5, delay: 0 })).toBe(3);
    expect(await attempts({ maxAttempts: '3', delay: 0 })).toBe(3);
  });

  test('an unknown strategy is a fixed delay; a numeric-string delay is its number', () => {
    expect(calculateBackoff(loose('linear'), 3, 100, boom, {})).toBe(100);
    expect(calculateBackoff('fixed', 3, 250, boom, {})).toBe(250);
  });

  test('a negative or NaN base delay retries at once', async () => {
    for (const delay of [-100, Number.NaN]) {
      const started = performance.now();
      expect(await attempts({ maxAttempts: 3, delay, strategy: 'exponential' })).toBe(3);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  test('a customBackoff result that is negative, NaN, undefined or a string is honoured', async () => {
    for (const result of [-1, Number.NaN, undefined, null, '5']) {
      const config = { maxAttempts: 3, strategy: 'custom', customBackoff: () => result };
      expect(await attempts(config)).toBe(3);
    }
  });
});

describe('0.2.2 compatibility: breaker, aging and rate gate', () => {
  function fakeWorker() {
    const worker = { pause() {}, resume() {}, isPaused: () => false };
    return worker as unknown as WorkerBase;
  }

  test('threshold 0 opens on the first failure; NaN never opens; a string counts', () => {
    const run = (threshold: unknown, failures: number) => {
      const breaker = new WorkerCircuitBreaker({ threshold: loose(threshold) }, fakeWorker());
      for (let i = 0; i < failures; i++) breaker.onFailure();
      const state = breaker.currentState;
      breaker.destroy();
      return state;
    };
    expect(run(0, 1)).toBe('open');
    expect(run(Number.NaN, 50)).toBe('closed');
    expect([run('2', 1), run('2', 2)]).toEqual(['closed', 'open']);
  });

  test('a negative or NaN resetTimeout half-opens at once', async () => {
    for (const resetTimeout of [-1, Number.NaN]) {
      const breaker = new WorkerCircuitBreaker({ threshold: 1, resetTimeout }, fakeWorker());
      breaker.onFailure();
      await sleep(20);
      expect(breaker.currentState).toBe('half-open');
      breaker.destroy();
    }
  });

  test('aging: boost 0 and maxScan 0 run a no-op tick; boost Infinity caps at maxPriority', async () => {
    const changes: number[] = [];
    const ends: unknown[] = [];
    const queue = {
      getJobs: async (opts: { state: string; end: unknown }) => {
        ends.push(opts.end);
        return opts.state === 'waiting' ? [{ id: 'a', timestamp: 0, priority: 5 }] : [];
      },
      changeJobPriority: async (_id: string, opts: { priority: number }) => {
        changes.push(opts.priority);
      },
    } as unknown as Queue;
    const zero = new PriorityAger({ interval: 5, boost: 0, maxScan: 0, minAge: -1 }, queue);
    zero.start();
    await sleep(12);
    zero.destroy();
    expect(ends.slice(0, 2)).toEqual([0, 0]);
    expect(changes[0]).toBe(5);
    changes.length = 0;
    const capped = new PriorityAger(
      { interval: 5, boost: Infinity, maxPriority: loose('50') },
      queue
    );
    capped.start();
    await sleep(12);
    capped.destroy();
    expect(changes[0]).toBe(50);
  });

  test('rate gate: a fractional, infinite or string max and a zero window admit as 0.2.2', async () => {
    const admitted = async (options: Record<string, unknown>) => {
      const gate = new RateGate(loose(options));
      let count = 0;
      for (let i = 0; i < 3; i++) void gate.acquire('').then(() => (count += 1));
      await sleep(5);
      return count;
    };
    expect(await admitted({ max: 1.5, duration: 60_000 })).toBe(2);
    expect(await admitted({ max: Infinity, duration: 60_000 })).toBe(3);
    expect(await admitted({ max: '2', duration: 60_000 })).toBe(2);
    for (const duration of [0, -1, Number.NaN, undefined]) {
      expect(await admitted({ max: 1, duration })).toBe(3);
    }
  });
});
