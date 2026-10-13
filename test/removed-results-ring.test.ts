/**
 * The ring behind the removed-result record (`src/application/removedResults.ts`): a
 * completion only writes its slot, the `jobId` index is built by the first read after
 * it, a batch shares one clock reading, and a dropped record releases its result at once
 * and its slot when the head passes it. A seeded randomized history then checks the
 * invariants against a plain reference: nothing expired, superseded, forgotten or
 * obliterated ever answers, the cap is never exceeded, and a recent record the cap still
 * covers is never lost. The original store semantics are pinned by
 * removed-results.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { RemovedResults } from '../src/application/removedResults';
import { jobId, type JobId } from '../src/domain/types/job';

const id = (value: string): JobId => jobId(value);

function store(ttlMs: number, maxEntries: number, start = 1_000) {
  let now = start;
  let reads = 0;
  const results = new RemovedResults({
    ttlMs,
    maxEntries,
    clock: () => {
      reads++;
      return now;
    },
  });
  return {
    results,
    advance: (ms: number) => (now += ms),
    reads: () => reads,
  };
}

describe('RemovedResults ring', () => {
  test('a batch stamps every record with the one clock reading it was given', () => {
    const { results, advance, reads } = store(100, 10);
    const stamp = results.now();
    advance(40);
    results.record(id('a'), 'q', 1, stamp);
    results.record(id('b'), 'q', 2, stamp);
    expect(reads()).toBe(1);

    advance(59); // 99 ms after the stamp
    expect(results.lookup(id('a'))?.expiresAt).toBe(1_100);
    advance(1);
    expect(results.lookup(id('a'))).toBeUndefined();
    expect(results.lookup(id('b'))).toBeUndefined();
  });

  test('records wrap around the ring and keep answering in order', () => {
    const { results } = store(60_000, 5);
    for (let n = 0; n < 23; n++) results.record(id(`j${n}`), 'q', n);

    expect(results.size).toBe(5);
    for (let n = 18; n < 23; n++) expect(results.lookup(id(`j${n}`))?.result).toBe(n);
    expect(results.lookup(id('j17'))).toBeUndefined();
  });

  test('a cap eviction of records never read keeps the later index consistent', () => {
    const { results } = store(60_000, 4);
    results.record(id('a'), 'q', 'a');
    expect(results.lookup(id('a'))?.result).toBe('a'); // a is indexed, the rest pending
    for (const name of ['b', 'c', 'd', 'e', 'f', 'g']) results.record(id(name), 'q', name);

    expect(results.lookup(id('a'))).toBeUndefined();
    expect(results.lookup(id('c'))).toBeUndefined();
    for (const name of ['d', 'e', 'f', 'g']) expect(results.lookup(id(name))?.result).toBe(name);
    expect(results.size).toBe(4);
  });

  test('a re-recorded ID answers its newest record only, and counts once', () => {
    const { results, advance } = store(100, 10);
    results.record(id('a'), 'q1', 'first');
    results.record(id('b'), 'q1', 'b');
    results.record(id('a'), 'q2', 'second');

    expect(results.size).toBe(2);
    expect(results.lookup(id('a'))).toEqual({ queue: 'q2', result: 'second', expiresAt: 1_100 });
    expect(results.forgetQueue('q1')).toBe(1);
    expect(results.lookup(id('a'))?.result).toBe('second');
    advance(100);
    expect(results.lookup(id('a'))).toBeUndefined();
  });

  test('a dropped record answers no more; its slot is freed when the head passes it', () => {
    const { results } = store(60_000, 3);
    results.record(id('a'), 'q', 'a');
    results.record(id('b'), 'q', 'b');
    results.record(id('c'), 'q', 'c');
    expect(results.forget(id('a'))).toBe(true);
    expect(results.size).toBe(2);

    // The forgotten head slot is the one freed at the cap: b and c survive.
    results.record(id('d'), 'q', 'd');
    expect(results.size).toBe(3);
    for (const name of ['b', 'c', 'd']) expect(results.lookup(id(name))?.result).toBe(name);
    expect(results.lookup(id('a'))).toBeUndefined();
  });

  test('purgeExpired frees dropped slots at the head along with expired records', () => {
    const { results, advance } = store(100, 10);
    results.record(id('a'), 'q', 1);
    results.record(id('b'), 'q', 2);
    advance(50);
    results.record(id('c'), 'q', 3);
    results.forget(id('b'));

    advance(50);
    expect(results.purgeExpired()).toBe(1); // a; the forgotten b is not counted
    expect(results.size).toBe(1);
    expect(results.lookup(id('c'))?.result).toBe(3);
  });

  test('a dropped or evicted record releases its result at once', async () => {
    const results = new RemovedResults({ ttlMs: 60_000, maxEntries: 60 });
    const refs: WeakRef<object>[] = [];
    for (let n = 0; n < 100; n++) {
      const result = { payload: new Array(64).fill(n) };
      refs.push(new WeakRef(result));
      results.record(id(`w${n}`), n % 2 ? 'odd' : 'even', result);
    }
    // 40 evicted at the cap; of the 60 held, 10 forgotten and the 30 odd obliterated.
    for (let n = 40; n < 60; n += 2) results.forget(id(`w${n}`));
    results.forgetQueue('odd');
    expect(results.size).toBe(20);

    await Bun.sleep(0); // WeakRef targets stay alive until the current job ends
    Bun.gc(true);
    const alive = refs.filter((ref) => ref.deref() !== undefined).length;
    // Conservative stack scanning may keep a stray one or two.
    expect(alive).toBeLessThanOrEqual(22);
  });

  test('an expired record purged without new completions releases its result', async () => {
    const { results, advance } = store(100, 1_000);
    const refs: WeakRef<object>[] = [];
    for (let n = 0; n < 40; n++) {
      const result = { payload: new Array(64).fill(n) };
      refs.push(new WeakRef(result));
      results.record(id(`e${n}`), 'q', result);
    }
    advance(100);
    expect(results.purgeExpired()).toBe(40);

    await Bun.sleep(0);
    Bun.gc(true);
    expect(refs.filter((ref) => ref.deref() !== undefined).length).toBeLessThanOrEqual(2);
  });

  test('clear empties the ring, the index and the counters', () => {
    const { results } = store(60_000, 3);
    for (const name of ['a', 'b', 'c', 'd']) results.record(id(name), 'q', name);
    results.forget(id('c'));
    results.clear();

    expect(results.size).toBe(0);
    expect(results.lookup(id('d'))).toBeUndefined();
    for (const name of ['e', 'f', 'g', 'h']) results.record(id(name), 'q', name);
    expect(results.size).toBe(3);
    expect(results.lookup(id('h'))?.result).toBe('h');
  });
});

/** Mulberry32: a small deterministic PRNG, so a failing seed replays. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Expected {
  readonly queue: string;
  readonly result: unknown;
  readonly expiresAt: number;
  /** Position of the record among all records, to know how many came after it. */
  readonly seq: number;
}

function runHistory(seed: number, ttlMs: number, maxEntries: number, steps: number): void {
  const random = prng(seed);
  let now = 10_000;
  const records = new RemovedResults({ ttlMs, maxEntries, clock: () => now });
  const evictBatch = Math.max(1, Math.ceil(maxEntries * 0.1));
  // The latest record of each ID unless dropped since: all a lookup may answer.
  const latest = new Map<JobId, Expected>();
  let recorded = 0;
  const ids = Array.from({ length: maxEntries * 3 }, (_, n) => jobId(`job-${n}`));
  const queues = ['qa', 'qb', 'qc'];
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];

  const record = (jobIdValue: JobId, stamp: number): void => {
    const queue = pick(queues);
    const result = random() < 0.2 ? undefined : { seed, n: recorded };
    records.record(jobIdValue, queue, result, stamp);
    latest.set(jobIdValue, { queue, result, expiresAt: stamp + ttlMs, seq: recorded++ });
  };

  for (let step = 0; step < steps; step++) {
    const roll = random();
    if (roll < 0.35) {
      record(pick(ids), now);
    } else if (roll < 0.45) {
      // A batch ACK: one clock reading for every record of the batch.
      const stamp = records.now();
      const size = 1 + Math.floor(random() * evictBatch * 3);
      for (let n = 0; n < size; n++) record(pick(ids), stamp);
    } else if (roll < 0.7) {
      const target = pick(ids);
      const found = records.lookup(target);
      const expected = latest.get(target);
      if (found !== undefined) {
        // Never expired, never stale: exactly the latest record not dropped since.
        expect(found.expiresAt).toBeGreaterThan(now);
        expect(found).toEqual({
          queue: expected?.queue,
          result: expected?.result,
          expiresAt: expected?.expiresAt,
        } as never);
      } else if (expected !== undefined && expected.expiresAt > now) {
        // Missing although unexpired: only the cap may have evicted it.
        expect(recorded - 1 - expected.seq).toBeGreaterThanOrEqual(maxEntries - evictBatch);
      }
      if (expected !== undefined && (found === undefined || expected.expiresAt <= now)) {
        latest.delete(target);
      }
    } else if (roll < 0.8) {
      const target = pick(ids);
      records.forget(target);
      expect(records.lookup(target)).toBeUndefined();
      latest.delete(target);
    } else if (roll < 0.83) {
      const queue = pick(queues);
      records.forgetQueue(queue);
      for (const [key, expected] of latest) if (expected.queue === queue) latest.delete(key);
    } else if (roll < 0.88) {
      records.purgeExpired();
    } else {
      now += Math.floor(random() * ttlMs * 0.4);
    }
    expect(records.size).toBeLessThanOrEqual(maxEntries);
    expect(records.capacity).toBeLessThanOrEqual(maxEntries);
  }
}

describe('RemovedResults randomized history', () => {
  test.each([
    [1, 100, 10],
    [2, 100, 1],
    [3, 50, 7],
    [4, 1_000, 100],
    [5, 30, 3],
    [6, 200, 25],
    // Caps far above the live records: the ring grows, shrinks and wraps meanwhile.
    [7, 40, 500],
    [8, 100, 2_000],
  ])('seed %p (ttl %p, cap %p): nothing expired, stale or dropped answers', (seed, ttl, cap) => {
    runHistory(seed, ttl, cap, 6_000);
  });
});
