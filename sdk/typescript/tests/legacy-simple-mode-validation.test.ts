/**
 * Legacy entry: Simple Mode (Bunqueue) option validation.
 *
 * The Bunqueue constructor rejects, before its Queue and Worker exist, the values that
 * 0.2.2 turned into a spin, a hang or a crash, and the options it forwards to the Worker
 * are named as the main client names them. Every value 0.2.2 handled correctly keeps
 * 0.2.2's result: see legacy-compat-simple-mode.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { Bunqueue } from '../src/bunqueue/bunqueue.js';
import type { BunqueueOptions } from '../src/bunqueue/types.js';

describe('Simple Mode option validation', () => {
  const processor = async () => 'ok';
  const base = { processor, autorun: false } as BunqueueOptions;

  const cases: Array<[Partial<BunqueueOptions>, string]> = [
    [{ priorityAging: { interval: 0 } }, 'Bunqueue: priorityAging.interval'],
    [{ priorityAging: { interval: Number.NaN } }, 'Bunqueue: priorityAging.interval'],
    [{ priorityAging: { maxScan: Number.POSITIVE_INFINITY } }, 'Bunqueue: priorityAging.maxScan'],
    [{ priorityAging: { boost: '2' as never } }, 'Bunqueue: priorityAging.boost'],
    [{ retry: { delay: Number.POSITIVE_INFINITY } }, 'Bunqueue: retry.delay'],
    [{ retry: { delay: 'soon' as never } }, 'Bunqueue: retry.delay'],
    [
      { circuitBreaker: { resetTimeout: 'soon' as never } },
      'Bunqueue: circuitBreaker.resetTimeout',
    ],
    [{ rateLimit: { max: 0, duration: 1000 } }, 'Bunqueue: rateLimit.max'],
    [{ rateLimit: { max: Number.NaN, duration: 1000 } }, 'Bunqueue: rateLimit.max'],
    [{ limiter: { max: 1, duration: Number.POSITIVE_INFINITY } }, 'Bunqueue: limiter.duration'],
    [{ pollTimeout: 'soon' as unknown as number }, 'Worker: pollTimeout'],
    [{ concurrency: 0 }, 'Worker: concurrency'],
  ];

  for (const [extra, message] of cases) {
    test(`rejects ${message}`, () => {
      expect(() => new Bunqueue('validation', { ...base, ...extra })).toThrow(message);
    });
  }

  // The received value is shown as the main client shows it (describeValue, from
  // src/shared/durations.ts through ../src/timing.ts).
  test.each([
    [
      { retry: { delay: Number.POSITIVE_INFINITY } },
      RangeError,
      'retry.delay must be a finite number of milliseconds (got Infinity)',
    ],
    [
      { priorityAging: { boost: '2' as never } },
      TypeError,
      'priorityAging.boost must be a number (got "2")',
    ],
    [
      { rateLimit: { max: -0, duration: 1 } },
      RangeError,
      'rateLimit.max must be a number of job starts > 0 (got -0)',
    ],
    [
      { limiter: { max: 3n as never, duration: 1 } },
      TypeError,
      'limiter.max must be a number of job starts > 0 (got 3n)',
    ],
  ] as const)('the message shows the received value exactly: %#', (extra, ErrorType, message) => {
    const make = () =>
      new Bunqueue('validation', { ...base, ...(extra as Partial<BunqueueOptions>) });
    expect(make).toThrow(ErrorType);
    expect(make).toThrow(`Bunqueue: ${message}`);
  });

  test('batch.timeout must be finite; batch.size is compared as 0.2.2 compared it', async () => {
    const batchProcessor = async (jobs: unknown[]) => jobs.map(() => 'ok');
    expect(
      () =>
        new Bunqueue('validation', {
          autorun: false,
          batch: { size: 2, timeout: Number.POSITIVE_INFINITY, processor: batchProcessor },
        })
    ).toThrow('Bunqueue: batch.timeout');
    const app = new Bunqueue('validation', {
      autorun: false,
      batch: { size: 0, timeout: Number.NaN, processor: batchProcessor },
    });
    await app.close();
  });

  test('valid edge values are accepted (Infinity where it means never or unlimited)', async () => {
    const app = new Bunqueue('validation', {
      ...base,
      retry: { maxAttempts: Number.POSITIVE_INFINITY, delay: 0 },
      circuitBreaker: { threshold: Number.POSITIVE_INFINITY, resetTimeout: Infinity },
      heartbeatInterval: 0,
      pollTimeout: Number.POSITIVE_INFINITY,
    });
    await app.close();
  });

  // sdk/CLAUDE.md rule 4: the forwarded heartbeat disables on 0, negative and non-finite
  // values, and the forwarded poll timeout clamps. A null heartbeatInterval disables
  // heartbeats (0.2.2 forwarded null / 1000 = 0); a null pollTimeout keeps the default.
  test('forwarded heartbeatInterval and pollTimeout follow the SDK clamps', async () => {
    const cases: Array<[Partial<BunqueueOptions>, number, number]> = [
      [{ heartbeatInterval: Number.NaN, pollTimeout: Number.NaN }, 0, 5000],
      [{ heartbeatInterval: -1, pollTimeout: -1 }, 0, 0],
      [{ heartbeatInterval: Number.POSITIVE_INFINITY, pollTimeout: 99_000 }, 0, 30_000],
      [{ heartbeatInterval: 2500, pollTimeout: 300 }, 2.5, 300],
      [{ heartbeatInterval: null as unknown as number, pollTimeout: null as never }, 0, 5000],
    ];
    for (const [extra, heartbeatIntervalS, pollTimeoutMs] of cases) {
      const app = new Bunqueue('validation', { ...base, ...extra });
      try {
        expect(app.worker.heartbeatIntervalS).toBe(heartbeatIntervalS);
        expect(app.worker.pollTimeoutMs).toBe(pollTimeoutMs);
      } finally {
        await app.close();
      }
    }
  });

  test('cancel() rejects an infinite or non-numeric grace period', async () => {
    const app = new Bunqueue('validation', base);
    try {
      expect(() => app.cancel('job', Number.POSITIVE_INFINITY)).toThrow(
        'Bunqueue: cancel() gracePeriodMs must be a finite number of milliseconds (got Infinity)'
      );
      expect(() => app.cancel('job', 'soon' as unknown as number)).toThrow(TypeError);
      // 0.2.2: NaN or a negative grace cancels at once.
      expect(() => app.cancel('job', Number.NaN)).not.toThrow();
      expect(() => app.cancel('job')).not.toThrow();
    } finally {
      await app.close();
    }
  });
});
