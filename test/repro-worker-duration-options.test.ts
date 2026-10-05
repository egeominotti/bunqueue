/**
 * Repro: Worker durations that reach a broker command or lease were never validated.
 *
 * - `pollTimeout` was only clamped with `Math.min(value, 30000)`: NaN or a negative
 *   value went out as the PULL `timeout`, the server rejected every PULL, and the Worker
 *   read each rejection as an empty queue, so a TCP Worker silently never got a job.
 *   Such a value now means 0 (no long-poll), as 2.9.10's `pollTimeout > 0` guard and
 *   its embedded pull read it (test/repro-compat-client-worker.test.ts).
 * - `lockDuration` went out as the lease TTL (`lockTtl`) unchecked: NaN gives a lease
 *   whose expiry is NaN, which never expires, and 0 or a negative value a lease that is
 *   already expired when granted.
 * - `extendJobLocks(ids, tokens, duration)` renewed leases by the same unchecked value.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';
import { getSharedManager } from '../src/client/manager';
import { jobId } from '../src/domain/types/job';

const workers: Worker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close(true);
  shutdownManager();
});

const unique = (label: string) => `repro-durations-${label}-${crypto.randomUUID()}`;

function makeWorker(name: string, options: ConstructorParameters<typeof Worker>[2] = {}): Worker {
  const worker = new Worker(name, async () => 1, {
    embedded: true,
    autorun: false,
    heartbeatInterval: 0,
    ...options,
  });
  workers.push(worker);
  return worker;
}

const message = (option: string, shown: string, bound = '>= 0') =>
  `Worker: ${option} must be a finite number of milliseconds ${bound} (got ${shown})`;

describe('Worker pollTimeout', () => {
  test.each([[Number.NaN], [-1], [Number.NEGATIVE_INFINITY]])(
    '%p means no long-poll (0) instead of being sent as the PULL timeout',
    (value) => {
      expect(makeWorker(unique('poll'), { pollTimeout: value }).opts.pollTimeout).toBe(0);
    }
  );

  test('rejects a non-numeric string with a TypeError; a numeric one is a number', () => {
    expect(() => makeWorker(unique('poll'), { pollTimeout: 'soon' as unknown as number })).toThrow(
      TypeError
    );
    expect(
      makeWorker(unique('poll'), { pollTimeout: '100' as unknown as number }).opts.pollTimeout
    ).toBe(100);
  });

  test('values above 30000, Infinity included, are still clamped to 30000', () => {
    expect(makeWorker(unique('poll'), { pollTimeout: 120_000 }).opts.pollTimeout).toBe(30_000);
    expect(
      makeWorker(unique('poll'), { pollTimeout: Number.POSITIVE_INFINITY }).opts.pollTimeout
    ).toBe(30_000);
    expect(makeWorker(unique('poll'), { pollTimeout: 0 }).opts.pollTimeout).toBe(0);
  });
});

describe('Worker lockDuration', () => {
  test.each([
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [0, '0'],
    [-1, '-1'],
  ])('rejects %p at construction instead of sending it as the lease TTL', (value, shown) => {
    // The broker's lockTtl bound is 1..MAX_SAFE_INTEGER, so the Worker uses the same one.
    expect(() => makeWorker(unique('lock'), { lockDuration: value })).toThrow(
      new RangeError(message('lockDuration', shown, `between 1 and ${Number.MAX_SAFE_INTEGER}`))
    );
  });

  test('rejects a lockDuration above the broker bound (MAX_SAFE_INTEGER)', () => {
    // Accepted before, then every PULL was refused by the broker (`lockTtl must be at most`).
    expect(() => makeWorker(unique('lock'), { lockDuration: 1e16 })).toThrow(
      new RangeError(
        message('lockDuration', '10000000000000000', `between 1 and ${Number.MAX_SAFE_INTEGER}`)
      )
    );
    expect(() =>
      makeWorker(unique('lock'), { lockDuration: Number.MAX_SAFE_INTEGER })
    ).not.toThrow();
  });

  test('rejects a non-numeric string with a TypeError; a numeric one is a number', () => {
    expect(() => makeWorker(unique('lock'), { lockDuration: 'long' as unknown as number })).toThrow(
      TypeError
    );
    expect(
      makeWorker(unique('lock'), { lockDuration: '30000' as unknown as number }).opts.lockDuration
    ).toBe(30_000);
  });

  test('a valid lockDuration, even above the timer limit, sets the lease expiry', async () => {
    const name = unique('lease');
    const queue = new Queue(name, { embedded: true });
    try {
      const added = await queue.add('job', {});
      const worker = makeWorker(name, { lockDuration: 3_000_000_000 });
      const before = Date.now();
      const job = await worker.getNextJob();
      expect(String(job?.id)).toBe(added.id);
      const lease = getSharedManager().getLockInfo(jobId(added.id));
      expect(lease?.expiresAt).toBeGreaterThanOrEqual(before + 3_000_000_000);
      expect(lease?.expiresAt).toBeLessThanOrEqual(Date.now() + 3_000_000_000);
    } finally {
      await queue.close();
    }
  });
});

describe('Worker.extendJobLocks', () => {
  test.each([
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [0, '0'],
    [-1, '-1'],
  ])('rejects a %p duration instead of renewing the lease by it', async (value, shown) => {
    const name = unique('extend');
    const queue = new Queue(name, { embedded: true });
    try {
      await queue.add('job', {});
      const worker = makeWorker(name);
      const job = await worker.getNextJob();
      const lease = getSharedManager().getLockInfo(jobId(String(job?.id)));
      const expiresAt = lease?.expiresAt;
      await expect(
        worker.extendJobLocks([String(job?.id)], [String(job?.token)], value)
      ).rejects.toThrow(
        new RangeError(
          `Worker.extendJobLocks: duration must be a finite number of milliseconds >= 1 (got ${shown})`
        )
      );
      expect(getSharedManager().getLockInfo(jobId(String(job?.id)))?.expiresAt).toBe(expiresAt);
    } finally {
      await queue.close();
    }
  });
});
