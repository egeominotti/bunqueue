/**
 * Repro (2.9.10 compatibility): Worker options and methods that 2.9.10 accepted with a
 * well-defined result must keep that result. The 2.9.11 candidate threw for them:
 *
 * - `concurrency: 2.5` ran 3 jobs at once (the gate is `active >= 2.5`), `"4"` ran 4
 *   and `Infinity` ran every pulled job at once; the setter behaved the same;
 * - a negative `heartbeatInterval` or `pollTimeout` meant 0 (the guards are `> 0`), and
 *   NaN did too (no timer was armed, no long-poll was requested);
 * - `drainDelay` is read only without a long-poll (`pollTimeout > 0 ? 10 : drainDelay`)
 *   and `lockDuration` only with locks, and `batchSize` is unused under `batch`;
 * - numeric strings for `pollTimeout`, `batchSize`, `drainDelay`, `heartbeatInterval`
 *   and `lockDuration` read as numbers, and `batchSize: 2.5` pulled 3 jobs;
 * - `delay(-1)` resolved at once and `rateLimit(-1)` did nothing.
 *
 * What 2.9.10 could not run still throws: `concurrency` 0 or NaN (no job ever ran),
 * `batchSize: 0` (never pulled), `lockDuration: 0` with locks (a job ran twice),
 * `drainDelay: 0` without a long-poll (a ~1 ms re-poll), a heartbeat below 1 ms.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';

const workers: Worker[] = [];
const queues: Queue[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close(true);
  for (const queue of queues.splice(0)) await queue.close();
  shutdownManager();
});

type Options = ConstructorParameters<typeof Worker>[2];
type Resolved = Record<string, unknown>;
let sequence = 0;

function makeWorker(options: Options = {}, processor = async () => 1): Worker {
  const worker = new Worker(`compat-worker-${++sequence}`, processor, {
    embedded: true,
    autorun: false,
    ...options,
  });
  workers.push(worker);
  return worker;
}

const opts = (worker: Worker) => (worker as unknown as { opts: Resolved }).opts;
const asNumber = (value: string) => value as unknown as number;

/** Run `jobs` jobs of `ms` each and report the highest number running at once. */
async function maxParallel(options: Options, jobs: number, ms = 150): Promise<number> {
  const name = `compat-parallel-${++sequence}`;
  const queue = new Queue(name, { embedded: true });
  queues.push(queue);
  let active = 0;
  let max = 0;
  let done = 0;
  const worker = new Worker(
    name,
    async () => {
      max = Math.max(max, ++active);
      await Bun.sleep(ms);
      active--;
      done++;
    },
    { embedded: true, ...options }
  );
  workers.push(worker);
  for (let index = 0; index < jobs; index++) await queue.add('job', { index });
  const deadline = Date.now() + 5_000;
  while (done < jobs && Date.now() < deadline) await Bun.sleep(10);
  expect(done).toBe(jobs);
  return max;
}

describe('concurrency keeps its 2.9.10 meaning', () => {
  test('2.5 runs 3 jobs at once', async () => {
    expect(makeWorker({ concurrency: 2.5 }).concurrency).toBe(3);
    expect(await maxParallel({ concurrency: 2.5 }, 6)).toBe(3);
  });

  test('"4" runs 4 jobs at once', async () => {
    expect(makeWorker({ concurrency: asNumber('4') }).concurrency).toBe(4);
    expect(await maxParallel({ concurrency: asNumber('4') }, 8)).toBe(4);
  });

  test('Infinity runs every pulled job at once', async () => {
    expect(makeWorker({ concurrency: Infinity }).concurrency).toBe(Infinity);
    expect(await maxParallel({ concurrency: Infinity }, 8)).toBe(8);
  });

  test('0, a negative value and NaN still throw (no job ever ran)', () => {
    for (const concurrency of [0, -1, NaN]) {
      expect(() => makeWorker({ concurrency })).toThrow('Worker: concurrency must be');
    }
  });

  test('the setter rounds up, coerces a numeric string and clamps below 1 to 1', () => {
    const worker = makeWorker();
    worker.concurrency = 2.5;
    expect(worker.concurrency).toBe(3);
    worker.concurrency = asNumber('6');
    expect(worker.concurrency).toBe(6);
    worker.concurrency = Infinity;
    expect(worker.concurrency).toBe(Infinity);
    worker.concurrency = 0;
    expect(worker.concurrency).toBe(1);
    expect(() => (worker.concurrency = NaN)).toThrow('Worker.concurrency');
  });
});

describe('negative (and NaN) heartbeatInterval and pollTimeout mean 0', () => {
  test('heartbeatInterval -1 and NaN disable heartbeats, as on 2.9.10', () => {
    expect(opts(makeWorker({ heartbeatInterval: -1 })).heartbeatInterval).toBe(0);
    expect(opts(makeWorker({ heartbeatInterval: NaN })).heartbeatInterval).toBe(0);
  });

  test('pollTimeout -1 and NaN mean no long-poll, as on 2.9.10', () => {
    expect(opts(makeWorker({ pollTimeout: -1 })).pollTimeout).toBe(0);
    expect(opts(makeWorker({ pollTimeout: NaN })).pollTimeout).toBe(0);
  });

  test('a heartbeat that would flood still throws', () => {
    for (const heartbeatInterval of [0.5, Infinity]) {
      expect(() => makeWorker({ heartbeatInterval })).toThrow('Worker: heartbeatInterval must be');
    }
  });

  test('a Worker with heartbeatInterval -1 processes jobs', async () => {
    expect(await maxParallel({ heartbeatInterval: -1 }, 2, 10)).toBe(1);
  });
});

describe('options unused in the active mode are not validated as if used', () => {
  test('drainDelay 0 with a long-poll is accepted', () => {
    expect(() => makeWorker({ drainDelay: 0, pollTimeout: 5000 })).not.toThrow();
  });

  test('drainDelay 0 without a long-poll still throws (a ~1 ms re-poll)', () => {
    expect(() => makeWorker({ drainDelay: 0 })).toThrow('Worker: drainDelay must be');
  });

  test('lockDuration 0 with useLocks: false is accepted', () => {
    expect(() => makeWorker({ lockDuration: 0, useLocks: false })).not.toThrow();
  });

  test('lockDuration 0 with locks still throws (the lease expired at grant)', () => {
    expect(() => makeWorker({ lockDuration: 0 })).toThrow('Worker: lockDuration must be');
  });

  test('batchSize NaN is ignored under a native batch', () => {
    const worker = makeWorker({ batchSize: NaN, batch: { size: 5 } });
    expect(opts(worker).batchSize).toBe(5);
  });
});

describe('numeric strings and fractions keep their 2.9.10 values', () => {
  test('numeric strings read as numbers', () => {
    const resolved = opts(
      makeWorker({
        pollTimeout: asNumber('1000'),
        batchSize: asNumber('10'),
        drainDelay: asNumber('5'),
        heartbeatInterval: asNumber('1000'),
        lockDuration: asNumber('30000'),
      })
    );
    expect(resolved.pollTimeout).toBe(1000);
    expect(resolved.batchSize).toBe(10);
    expect(resolved.drainDelay).toBe(5);
    expect(resolved.heartbeatInterval).toBe(1000);
    expect(resolved.lockDuration).toBe(30000);
  });

  test('batchSize 2.5 pulls up to 3 jobs, as on 2.9.10', () => {
    expect(opts(makeWorker({ batchSize: 2.5 })).batchSize).toBe(3);
  });

  test('batchSize 0 still throws (it never pulled)', () => {
    expect(() => makeWorker({ batchSize: 0 })).toThrow('Worker: batchSize must be');
  });
});

describe('delay() and rateLimit() keep their 2.9.10 results', () => {
  test('delay(-1) resolves at once', async () => {
    const worker = makeWorker();
    const started = performance.now();
    await worker.delay(-1);
    await worker.delay(-0);
    expect(performance.now() - started).toBeLessThan(50);
  });

  test('delay(NaN) and delay(Infinity) still reject (2.9.10 slept ~1 ms with a warning)', async () => {
    const worker = makeWorker();
    await expect(worker.delay(NaN)).rejects.toThrow('Worker.delay: milliseconds');
    await expect(worker.delay(Infinity)).rejects.toThrow('Worker.delay: milliseconds');
  });

  test('rateLimit(-1), NaN, Infinity and null do nothing (2.9.10 guard)', () => {
    const worker = makeWorker();
    for (const ms of [-1, NaN, Infinity, null]) worker.rateLimit(ms as number);
    expect(worker.isRateLimited()).toBe(false);
    worker.rateLimit(asNumber('60000'));
    expect(worker.isRateLimited()).toBe(true);
  });

  test('delay("60") waits 60 ms, as the timer read it on 2.9.10', async () => {
    const started = performance.now();
    await makeWorker().delay(asNumber('60'));
    expect(performance.now() - started).toBeGreaterThanOrEqual(55);
  });

  test('the concurrency setter clamps null to 1', () => {
    const worker = makeWorker({ concurrency: 4 });
    worker.concurrency = null as unknown as number;
    expect(worker.concurrency).toBe(1);
  });
});

describe('extendJobLocks keeps its 2.9.10 results', () => {
  test('a closed Worker or empty ids return 0 before the duration is checked', async () => {
    const worker = makeWorker();
    expect(await worker.extendJobLocks([], [], null as unknown as number)).toBe(0);
    await worker.close(true);
    expect(await worker.extendJobLocks(['1'], ['t'], NaN)).toBe(0);
  });

  test('a null duration renews the lease with its own TTL', async () => {
    const name = `compat-extend-${++sequence}`;
    const queue = new Queue(name, { embedded: true });
    queues.push(queue);
    await queue.add('job', {});
    const worker = new Worker(name, async () => 1, { embedded: true, autorun: false });
    workers.push(worker);
    const job = await worker.getNextJob();
    expect(job?.token).toBeDefined();
    const extended = await worker.extendJobLocks(
      [String(job?.id)],
      [String(job?.token)],
      null as unknown as number
    );
    expect(extended).toBe(1);
    await expect(worker.extendJobLocks([String(job?.id)], [String(job?.token)], 0)).rejects.toThrow(
      'Worker.extendJobLocks: duration'
    );
  });
});
