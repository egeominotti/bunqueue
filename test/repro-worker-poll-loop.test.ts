/**
 * Repro: the Worker pull loop re-arms itself with a bare `setTimeout(poll, delay)`
 * (`runtime/polling.ts`). The delay is `drainDelay` (unvalidated), the rolling limiter
 * wait (`limiter.duration`, finite but unbounded) or a `Worker.rateLimit(ms)` override
 * (finite but unbounded). The runtime arms NaN, a negative delay or anything above
 * 2^31 - 1 ms after about 1 ms, and a drainDelay of 0 re-polls continuously, so all of
 * them re-polled an empty or rate-limited queue about 870 times per second. A
 * `rateLimit` value that is not a positive finite number stays a no-op, as on 2.9.10
 * (BullMQ v5); a non-numeric string throws.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Queue, Worker, shutdownManager } from '../src/client';

/** About 34.7 days: above the 2^31 - 1 ms that one native timer accepts. */
const BEYOND_TIMER_LIMIT = 3_000_000_000;

const workers: Worker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close(true);
  shutdownManager();
});

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

/** Count the pull-loop wake-ups (`poll()` calls) of `worker`. */
function countPolls(worker: Worker): () => number {
  const internals = worker as unknown as { poll: () => void };
  const poll = internals.poll.bind(worker);
  let count = 0;
  internals.poll = () => {
    count++;
    poll();
  };
  return () => count;
}

/** Wake-ups of `worker` during the next `ms`, after `settle` ms of warm-up. */
async function pollsDuring(polls: () => number, ms: number, settle = 0): Promise<number> {
  if (settle > 0) await Bun.sleep(settle);
  const before = polls();
  await Bun.sleep(ms);
  return polls() - before;
}

const unique = (label: string) => `repro-poll-${label}-${crypto.randomUUID()}`;

describe('Worker drainDelay', () => {
  test.each([
    [Number.NaN, 'NaN'],
    [-1, '-1'],
    [0, '0'],
    [0.5, '0.5'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
  ])('rejects %p at construction, naming the option', (drainDelay, shown) => {
    expect(() => makeWorker(unique('invalid'), { drainDelay })).toThrow(
      new RangeError(
        `Worker: drainDelay must be a finite number of milliseconds >= 1 (got ${shown})`
      )
    );
  });

  test('a drainDelay above the timer limit does not re-poll an empty queue every millisecond', async () => {
    const worker = makeWorker(unique('long-drain'), { drainDelay: BEYOND_TIMER_LIMIT });
    const polls = countPolls(worker);
    worker.run();
    expect(await pollsDuring(polls, 60, 10)).toBe(0);
  });

  test('the default drainDelay still re-polls an empty queue every 50 ms', async () => {
    const worker = makeWorker(unique('default-drain'));
    const polls = countPolls(worker);
    worker.run();
    const wakeUps = await pollsDuring(polls, 160, 10);
    expect(wakeUps).toBeGreaterThanOrEqual(2);
    expect(wakeUps).toBeLessThanOrEqual(4);
  });
});

describe('Worker rate-limited poll loop', () => {
  test('a limiter window above the timer limit parks the loop instead of spinning', async () => {
    const name = unique('long-window');
    const queue = new Queue(name, { embedded: true });
    await queue.add('first', {});
    const second = await queue.add('second', {});
    const started = Promise.withResolvers<undefined>();
    const worker = new Worker(
      name,
      async () => {
        started.resolve(undefined);
        return 1;
      },
      {
        embedded: true,
        autorun: false,
        heartbeatInterval: 0,
        limiter: { max: 1, duration: BEYOND_TIMER_LIMIT },
      }
    );
    workers.push(worker);
    const polls = countPolls(worker);
    worker.run();
    await started.promise;
    expect(await pollsDuring(polls, 60, 20)).toBe(0);
    expect(await queue.getJobState(second.id)).toBe('waiting');
    await queue.close();
  });

  test('rateLimit above the timer limit parks the loop instead of spinning', async () => {
    const worker = makeWorker(unique('long-override'), { drainDelay: 5 });
    const polls = countPolls(worker);
    worker.run();
    worker.rateLimit(BEYOND_TIMER_LIMIT);
    expect(worker.isRateLimited()).toBe(true);
    expect(await pollsDuring(polls, 60, 20)).toBe(0);
  });

  test.each([[Number.NaN], [-1], [Number.POSITIVE_INFINITY]])(
    'rateLimit(%p) stays a no-op, as on 2.9.10',
    (ms) => {
      const worker = makeWorker(unique('override-invalid'));
      expect(() => worker.rateLimit(ms)).not.toThrow();
      expect(worker.isRateLimited()).toBe(false);
    }
  );

  test('rateLimit with a non-numeric string throws a TypeError', () => {
    const worker = makeWorker(unique('override-string'));
    expect(() => worker.rateLimit('soon' as unknown as number)).toThrow(TypeError);
    expect(worker.isRateLimited()).toBe(false);
  });

  test('rateLimit(0) stays a no-op', () => {
    const worker = makeWorker(unique('override-zero'));
    worker.rateLimit(0);
    expect(worker.isRateLimited()).toBe(false);
  });
});
