/**
 * Repro (2.9.10 compatibility): Simple Mode options that 2.9.10 accepted with a
 * well-defined result must keep that result. The 2.9.11 candidate threw for them:
 *
 * - `retry.maxAttempts`, `circuitBreaker.threshold` and `batch.size` are compared with
 *   `>=`, so 0 (or a negative value) behaved exactly like 1 and 2.5 like 3;
 * - an unknown `retry.strategy` (e.g. 'linear') fell through to a fixed delay;
 * - `priorityAging.maxPriority: Infinity` aged without a cap;
 * - a negative `retry.delay` or `circuitBreaker.resetTimeout` waited no time;
 * - `concurrency: 2.5` ran 3 jobs at once and `heartbeatInterval: -1` disabled the
 *   heartbeat (both forwarded to the Worker);
 * - `cancel(id, -1)` cancelled at once.
 *
 * `priorityAging.interval: 0` (a ~1 ms tick) still throws.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Bunqueue, shutdownManager, type BunqueueOptions } from '../src/client';
import { calculateBackoff } from '../src/client/bunqueue/retry';

const open: Array<Bunqueue<unknown, unknown>> = [];
let sequence = 0;

afterEach(async () => {
  for (const app of open.splice(0)) await app.close(true);
  shutdownManager();
});

type Options = Partial<BunqueueOptions<unknown, unknown>>;

function app(options: Options, autorun = false): Bunqueue<unknown, unknown> {
  const instance = new Bunqueue<unknown, unknown>(`compat-simple-${process.pid}-${++sequence}`, {
    embedded: true,
    autorun,
    ...(options.batch || options.routes ? {} : { processor: async () => null }),
    ...options,
  } as BunqueueOptions<unknown, unknown>);
  open.push(instance);
  return instance;
}

async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
  expect(condition()).toBe(true);
}

/** Run one always-failing job (no broker retry) and count the processor calls. */
async function attemptsFor(maxAttempts: number): Promise<number> {
  let calls = 0;
  let failed = false;
  const instance = app(
    {
      processor: async () => {
        calls++;
        throw new Error('boom');
      },
      retry: { maxAttempts, delay: 0, strategy: 'fixed' },
    },
    true
  );
  instance.on('failed', () => (failed = true));
  await instance.add('job', {}, { attempts: 1 });
  await until(() => failed);
  return calls;
}

describe('counts compared with >= keep their 2.9.10 meaning', () => {
  test('retry.maxAttempts 0 and -1 make one attempt, 2.5 makes three', async () => {
    expect(await attemptsFor(0)).toBe(1);
    expect(await attemptsFor(-1)).toBe(1);
    expect(await attemptsFor(2.5)).toBe(3);
  });

  test('circuitBreaker.threshold 0 opens on the first failure', async () => {
    const opened: number[] = [];
    const instance = app(
      {
        processor: async () => {
          throw new Error('boom');
        },
        circuitBreaker: { threshold: 0, resetTimeout: 60_000, onOpen: (n) => opened.push(n) },
      },
      true
    );
    await instance.add('job', {}, { attempts: 1 });
    await until(() => opened.length > 0);
    expect(opened[0]).toBe(1);
  });

  test('circuitBreaker.threshold 2.5 is accepted', () => {
    expect(() => app({ circuitBreaker: { threshold: 2.5 } })).not.toThrow();
  });

  test('batch.size 0 flushes each job alone, as size 1 does', async () => {
    const sizes: number[] = [];
    const instance = app(
      {
        batch: {
          size: 0,
          timeout: 60_000,
          processor: async (jobs) => {
            sizes.push(jobs.length);
            return jobs.map(() => null);
          },
        },
      },
      true
    );
    await instance.add('a', {});
    await instance.add('b', {});
    await until(() => sizes.length === 2);
    expect(sizes).toEqual([1, 1]);
  });

  test('batch.size 2.5 is accepted', () => {
    const batch = { size: 2.5, processor: async (jobs: unknown[]) => jobs.map(() => null) };
    expect(() => app({ batch } as Options)).not.toThrow();
  });
});

describe('retry.strategy outside the known set', () => {
  test("'linear' is accepted, warns once at construction and waits a fixed delay", () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      app({ retry: { strategy: 'linear' as never, delay: 100 } });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('retry.strategy');
      expect(String(warn.mock.calls[0][0])).toContain('"linear"');
    } finally {
      warn.mockRestore();
    }
    const error = new Error('boom');
    for (const attempt of [1, 2, 5]) {
      expect(calculateBackoff('linear' as never, attempt, 100, error, {})).toBe(100);
    }
  });

  test('a known strategy logs nothing', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      app({ retry: { strategy: 'exponential' } });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('durations and limits', () => {
  test('priorityAging.maxPriority Infinity ages without a cap', () => {
    expect(() => app({ priorityAging: { maxPriority: Infinity } })).not.toThrow();
  });

  test('a negative retry.delay or circuitBreaker.resetTimeout means no wait', () => {
    expect(() => app({ retry: { delay: -1 } })).not.toThrow();
    expect(() => app({ circuitBreaker: { resetTimeout: -1 } })).not.toThrow();
  });

  test('priorityAging.interval 0 still throws (a ~1 ms tick)', () => {
    expect(() => app({ priorityAging: { interval: 0 } })).toThrow(
      'Bunqueue: priorityAging.interval must be'
    );
  });

  test('concurrency 2.5 and heartbeatInterval -1 reach the Worker as on 2.9.10', () => {
    const instance = app({ concurrency: 2.5, heartbeatInterval: -1 });
    expect(instance.worker.concurrency).toBe(3);
  });
});

describe("second audit (default entry): the legacy entry's decisions", () => {
  test("retry.maxAttempts '3' makes three attempts; NaN means no limit", async () => {
    expect(await attemptsFor('3' as unknown as number)).toBe(3);
    expect(() => app({ retry: { maxAttempts: NaN } })).not.toThrow();
  });

  test('NaN thresholds and sizes are no limit; an omitted batch.size flushes on timeout', () => {
    expect(() => app({ circuitBreaker: { threshold: NaN } })).not.toThrow();
    const processor = async (jobs: unknown[]) => jobs.map(() => null);
    expect(() => app({ batch: { processor } } as unknown as Options)).not.toThrow();
    expect(() => app({ batch: { size: NaN, processor } } as Options)).not.toThrow();
  });

  test('NaN one-shot delays mean 0; Infinity where it fired after ~1 ms still throws', () => {
    expect(() => app({ retry: { delay: NaN } })).not.toThrow();
    expect(() => app({ circuitBreaker: { resetTimeout: NaN } })).not.toThrow();
    const processor = async (jobs: unknown[]) => jobs.map(() => null);
    expect(() => app({ batch: { size: 2, timeout: -1, processor } } as Options)).not.toThrow();
    expect(() => app({ retry: { delay: Infinity } })).toThrow('Bunqueue: retry.delay');
  });

  test('aging boost 0, maxScan 0, minAge -1 and a string interval are accepted', () => {
    expect(() =>
      app({ priorityAging: { boost: 0, maxScan: 0, minAge: -1, interval: '60000' as never } })
    ).not.toThrow();
    expect(() => app({ priorityAging: { boost: -1, minAge: Infinity } })).not.toThrow();
    expect(() => app({ priorityAging: { boost: NaN } })).toThrow('Bunqueue: priorityAging.boost');
    expect(() => app({ priorityAging: { maxScan: Infinity } })).toThrow('priorityAging.maxScan');
  });

  test('falsy callbacks are ignored; a non-function is rejected only where it is called', () => {
    expect(() =>
      app({ retry: { retryIf: false as never, customBackoff: 0 as never } })
    ).not.toThrow();
    expect(() => app({ retry: { customBackoff: 5 as never, strategy: 'fixed' } })).not.toThrow();
    expect(() => app({ retry: { retryIf: true as never } })).toThrow('Bunqueue: retry.retryIf');
    expect(() => app({ retry: { customBackoff: 5 as never, strategy: 'custom' } })).toThrow(
      'Bunqueue: retry.customBackoff'
    );
  });

  test('a customBackoff returning -1, undefined or NaN retries at once', async () => {
    for (const result of [-1, undefined, NaN]) {
      let calls = 0;
      let failed = false;
      const instance = app(
        {
          processor: async () => {
            calls++;
            throw new Error('boom');
          },
          retry: { maxAttempts: 2, strategy: 'custom', customBackoff: () => result as number },
        },
        true
      );
      instance.on('failed', () => (failed = true));
      await instance.add('job', {}, { attempts: 1 });
      await until(() => failed);
      expect(calls).toBe(2);
    }
  });
});

describe('cancel()', () => {
  test('a negative grace period cancels at once', async () => {
    let cancelledAtOnce: boolean | null = null;
    const instance: Bunqueue<unknown, unknown> = app(
      {
        processor: async (job) => {
          instance.cancel(job.id, -1);
          cancelledAtOnce = instance.isCancelled(job.id);
          return null;
        },
      },
      true
    );
    await instance.add('job', {});
    await until(() => cancelledAtOnce !== null);
    expect(cancelledAtOnce).toBe(true);
  });

  test('NaN cancels at once and a numeric string is a grace period; Infinity throws', () => {
    const instance = app({});
    expect(() => instance.cancel('unknown', NaN)).not.toThrow();
    expect(() => instance.cancel('unknown', '20' as unknown as number)).not.toThrow();
    expect(() => instance.cancel('unknown', Infinity)).toThrow('Bunqueue: cancel() gracePeriodMs');
  });
});
