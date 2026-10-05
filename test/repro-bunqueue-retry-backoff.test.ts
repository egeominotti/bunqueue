/**
 * Repro: Simple Mode in-process retry backoff outside the runtime's timer range.
 *
 * The documented strategies grow without a cap: with the default 1000 ms base,
 * `exponential` passes 2^31 - 1 ms (the native timer limit) at attempt 23, `jitter` at
 * 22 and `fibonacci` at 31, and the runtime then retries after about 1 ms. Far later
 * the arithmetic itself overflows to Infinity (or NaN for a zero base), and a
 * `customBackoff` can return anything. Driven on the fake runtime of
 * test/shared-timers-support.ts, which fires an out-of-range delay after 1 ms as the
 * real runtime does, so every wait between attempts is measured exactly.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { calculateBackoff, executeWithRetry } from '../src/client/bunqueue/retry';
import type { RetryConfig, RetryStrategy } from '../src/client/bunqueue/types';
import { installFakeTimers, restoreTimers } from './shared-timers-support';

const DAY = 86_400_000;
const LIMIT = 2_147_483_647;
let fake: ReturnType<typeof installFakeTimers>;

beforeEach(() => {
  fake = installFakeTimers();
});

afterEach(() => {
  restoreTimers();
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

/**
 * Run an always-failing retry through all `maxAttempts` attempts, firing each due
 * timer at its due time; return the waits between attempts (fake monotonic ms).
 */
async function retryGaps(
  config: RetryConfig & { maxAttempts: number }
): Promise<{ gaps: number[]; calls: number }> {
  const starts: number[] = [];
  const failure = new Error('still down');
  const outcome = executeWithRetry(() => {
    starts.push(fake.clock.mono);
    return Promise.reject(failure);
  }, config).then(
    () => 'resolved',
    (error: unknown) => error
  );
  await settle();
  while (starts.length < config.maxAttempts) {
    const started = starts.length;
    for (let guard = 0; starts.length === started; guard++) {
      if (guard > 100) throw new Error(`attempt ${started + 1} never started`);
      fake.runNext();
      await settle();
    }
  }
  // The last attempt fails at once: the outcome settles through microtasks alone.
  expect(await outcome).toBe(failure);
  return {
    gaps: starts.slice(1).map((start, index) => start - starts[index]),
    calls: starts.length,
  };
}

const fibonacci = (count: number): number[] => {
  const factors = [1, 2];
  while (factors.length < count) factors.push(factors.at(-1)! + factors.at(-2)!);
  return factors.slice(0, count);
};

describe('computed backoff beyond the timer limit', () => {
  test('exponential: attempt 23 waits 1000 * 2^22 ms, not about 1 ms', async () => {
    const { gaps, calls } = await retryGaps({ maxAttempts: 24, delay: 1_000 });
    expect(calls).toBe(24);
    expect(gaps).toEqual(Array.from({ length: 23 }, (_, index) => 1_000 * 2 ** index));
    expect(gaps[22]).toBeGreaterThan(LIMIT);
    expect(fake.invalid).toEqual([]);
  });

  test('jitter: attempt 22 waits its jittered delay, not about 1 ms', async () => {
    const random = spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      const { gaps } = await retryGaps({ maxAttempts: 23, delay: 1_000, strategy: 'jitter' });
      const expected = Array.from({ length: 22 }, (_, index) =>
        Math.floor(1_000 * 2 ** index * (0.5 + 0.99))
      );
      expect(gaps).toEqual(expected);
      expect(gaps[21]).toBeGreaterThan(LIMIT);
    } finally {
      random.mockRestore();
    }
    expect(fake.invalid).toEqual([]);
  });

  test('fibonacci: attempt 31 waits 1000 * 2178309 ms, not about 1 ms', async () => {
    const { gaps } = await retryGaps({ maxAttempts: 32, delay: 1_000, strategy: 'fibonacci' });
    expect(gaps).toEqual(fibonacci(31).map((factor) => 1_000 * factor));
    expect(gaps[30]).toBe(2_178_309_000);
    expect(fake.invalid).toEqual([]);
  });

  test('custom: a 30-day customBackoff waits 30 days', async () => {
    const { gaps } = await retryGaps({
      maxAttempts: 2,
      strategy: 'custom',
      customBackoff: () => 30 * DAY,
    });
    expect(gaps).toEqual([30 * DAY]);
    expect(fake.invalid).toEqual([]);
  });
});

describe('backoff arithmetic', () => {
  const error = new Error('failed');

  test('values below the saturation point follow the documented formulas exactly', () => {
    expect(calculateBackoff('fixed', 40, 1_500, error, {})).toBe(1_500);
    expect(calculateBackoff('exponential', 23, 1_000, error, {})).toBe(4_194_304_000);
    expect(calculateBackoff('fibonacci', 31, 1_000, error, {})).toBe(2_178_309_000);
    expect(calculateBackoff('exponential', 40, 1_000, error, {})).toBe(1_000 * 2 ** 39);
  });

  test('growth saturates at Number.MAX_SAFE_INTEGER instead of Infinity or NaN', () => {
    const cases: Array<[RetryStrategy, number, number]> = [
      ['exponential', 1_100, 1_000],
      ['jitter', 1_100, 1_000],
      ['fibonacci', 1_600, 1_000],
      ['fibonacci', 10_000_000, 1],
    ];
    const random = spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      for (const [strategy, attempt, base] of cases) {
        expect(calculateBackoff(strategy, attempt, base, error, {})).toBe(Number.MAX_SAFE_INTEGER);
      }
    } finally {
      random.mockRestore();
    }
  });

  test('a zero base stays zero at any attempt instead of becoming NaN', () => {
    for (const strategy of ['exponential', 'jitter', 'fibonacci'] as const) {
      expect(calculateBackoff(strategy, 1_100, 0, error, {})).toBe(0);
    }
  });
});

describe('customBackoff results', () => {
  // As on 2.9.10, whose timer ran them at once: NaN, a negative number, undefined and
  // null retry after 0 ms, and a numeric string waits that many ms.
  const kept: Array<[string, unknown, string]> = [
    ['NaN', NaN, '0'],
    ['a negative number', -1, '0'],
    ['undefined', undefined, '0'],
    ['null', null, '0'],
    ['a numeric string', '1000', '1000'],
  ];

  for (const [label, value, armed] of kept) {
    test(`returning ${label} retries after ${armed} ms, as on 2.9.10`, async () => {
      let calls = 0;
      void executeWithRetry(
        () => {
          calls++;
          return Promise.reject(new Error('processor failed'));
        },
        { maxAttempts: 2, strategy: 'custom', customBackoff: () => value as number }
      ).catch(() => undefined);
      await settle();

      expect(fake.armed.map((timer) => String(timer.ms))).toEqual([armed]);
      expect(calls).toBe(1);
    });
  }

  const invalid: Array<[string, unknown, ErrorConstructor]> = [
    ['Infinity', Infinity, RangeError],
    ['a non-numeric string', 'soon', TypeError],
    ['an object', {}, TypeError],
  ];

  for (const [label, value, ErrorType] of invalid) {
    test(`returning ${label} fails the attempt loop with a named error, without retrying`, async () => {
      const failure = new Error('processor failed');
      let calls = 0;
      let outcome: unknown = 'pending';
      void executeWithRetry(
        () => {
          calls++;
          return Promise.reject(failure);
        },
        { maxAttempts: 5, strategy: 'custom', customBackoff: () => value as number }
      ).then(
        () => (outcome = 'resolved'),
        (error: unknown) => (outcome = error)
      );
      await settle();

      expect(fake.armed.map((timer) => String(timer.ms))).toEqual([]);
      expect(calls).toBe(1);
      expect(outcome).toBeInstanceOf(ErrorType);
      expect((outcome as Error).message).toContain('retry.customBackoff');
      expect((outcome as Error).cause).toBe(failure);
    });
  }

  test('an exception thrown by customBackoff still propagates unchanged', async () => {
    const thrown = new Error('backoff policy failed');
    const outcome = await executeWithRetry(() => Promise.reject(new Error('processor failed')), {
      maxAttempts: 3,
      strategy: 'custom',
      customBackoff: () => {
        throw thrown;
      },
    }).then(
      () => null,
      (error: unknown) => error
    );
    expect(outcome).toBe(thrown);
    expect(thrown.cause).toBeUndefined();
  });
});
