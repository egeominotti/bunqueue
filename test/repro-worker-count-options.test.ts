/**
 * Repro: `concurrency` and `batchSize` reached the pull loop, the concurrency gate, the
 * TCP pool size (`min(concurrency, 8)`) and the PULLB `count` unchecked.
 *
 * - `concurrency: 0` built a Worker that never started a job and re-polled its full
 *   gate every 10 ms; NaN disabled the gate and sized the TCP pool to NaN connections.
 * - `batchSize: 0` or a negative value never pulled (silently idle); NaN sent
 *   `count: NaN`, which the broker refuses.
 * - the `concurrency` setter clamped with `Math.max(1, value)`, so NaN slipped through.
 *
 * Kept, as on 2.9.10 (test/repro-compat-client-worker.test.ts): a fraction rounds up
 * (the gate is `active >= concurrency`), `concurrency: Infinity` removes the limit, a
 * numeric string is that number, `batchSize` above 1000 (Infinity included) is clamped
 * to 1000, and the setter clamps a value below 1 to 1.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Worker, shutdownManager } from '../src/client';

const workers: Worker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close(true);
  shutdownManager();
});

function makeWorker(options: ConstructorParameters<typeof Worker>[2] = {}): Worker {
  const worker = new Worker('repro-count-options', async () => 1, {
    embedded: true,
    autorun: false,
    heartbeatInterval: 0,
    ...options,
  });
  workers.push(worker);
  return worker;
}

const concurrencyMessage = (shown: string) =>
  `Worker: concurrency must be a number > 0 or Infinity (got ${shown})`;
const batchSizeMessage = (shown: string) =>
  `Worker: batchSize must be a whole number >= 1 or Infinity (got ${shown})`;

describe('Worker concurrency', () => {
  test.each([
    [Number.NaN, 'NaN'],
    [0, '0'],
    [-1, '-1'],
    [Number.NEGATIVE_INFINITY, '-Infinity'],
  ])('rejects %p at construction, naming the option', (concurrency, shown) => {
    expect(() => makeWorker({ concurrency })).toThrow(new RangeError(concurrencyMessage(shown)));
  });

  test('rejects a non-numeric string with a TypeError', () => {
    expect(() => makeWorker({ concurrency: 'four' as unknown as number })).toThrow(TypeError);
  });

  test('a fraction rounds up, Infinity is kept and a numeric string is a number', () => {
    expect(makeWorker({ concurrency: 1.5 }).concurrency).toBe(2);
    expect(makeWorker({ concurrency: Number.POSITIVE_INFINITY }).concurrency).toBe(Infinity);
    expect(makeWorker({ concurrency: '4' as unknown as number }).concurrency).toBe(4);
  });

  test('undefined and null keep the default of 1; a whole number is kept', () => {
    expect(makeWorker().concurrency).toBe(1);
    expect(makeWorker({ concurrency: null as unknown as number }).concurrency).toBe(1);
    expect(makeWorker({ concurrency: 12 }).concurrency).toBe(12);
  });

  test('the setter rejects NaN and keeps the current value', () => {
    const worker = makeWorker({ concurrency: 3 });
    expect(() => {
      worker.concurrency = Number.NaN;
    }).toThrow(new RangeError('Worker.concurrency must be a number > 0 or Infinity (got NaN)'));
    expect(worker.concurrency).toBe(3);
  });

  test('the setter clamps below 1 to 1, rounds a fraction up and keeps Infinity', () => {
    const worker = makeWorker({ concurrency: 3 });
    worker.concurrency = 0;
    expect(worker.concurrency).toBe(1);
    worker.concurrency = -4;
    expect(worker.concurrency).toBe(1);
    worker.concurrency = 7;
    expect(worker.concurrency).toBe(7);
    worker.concurrency = 2.5;
    expect(worker.concurrency).toBe(3);
    worker.concurrency = Number.POSITIVE_INFINITY;
    expect(worker.concurrency).toBe(Infinity);
  });
});

describe('Worker batchSize', () => {
  test.each([
    [Number.NaN, 'NaN'],
    [0, '0'],
    [-1, '-1'],
    [Number.NEGATIVE_INFINITY, '-Infinity'],
  ])('rejects %p at construction, naming the option', (batchSize, shown) => {
    expect(() => makeWorker({ batchSize })).toThrow(new RangeError(batchSizeMessage(shown)));
  });

  test('rejects a non-numeric string with a TypeError', () => {
    expect(() => makeWorker({ batchSize: 'ten' as unknown as number })).toThrow(TypeError);
  });

  test('a fraction rounds up and a numeric string is a number', () => {
    expect(makeWorker({ batchSize: 2.5 }).opts.batchSize).toBe(3);
    expect(makeWorker({ batchSize: '10' as unknown as number }).opts.batchSize).toBe(10);
  });

  test('values above 1000, Infinity included, are clamped to 1000; the default is 10', () => {
    expect(makeWorker({ batchSize: 5_000 }).opts.batchSize).toBe(1_000);
    expect(makeWorker({ batchSize: Number.POSITIVE_INFINITY }).opts.batchSize).toBe(1_000);
    expect(makeWorker({ batchSize: 1 }).opts.batchSize).toBe(1);
    expect(makeWorker().opts.batchSize).toBe(10);
  });
});
