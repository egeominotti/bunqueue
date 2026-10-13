/**
 * The removed-result ring holds slots for its occupied records, not for its cap
 * (`src/application/removedResults.ts`). Its four slot arrays used to grow to the
 * highest slot ever written: because each record takes the slot after the newest one,
 * a large `maxRemovedResults` reached the cap's size (about 48 bytes a slot) once that
 * many records had been written, however few were live, until restart. The capacity
 * now doubles when the ring is full (up to the cap) and halves when an eviction leaves
 * it at most a quarter full; a resize re-lays the slots and moves the index with them.
 */
import { describe, expect, test } from 'bun:test';
import { RemovedResults } from '../src/application/removedResults';
import { jobId, type JobId } from '../src/domain/types/job';

const id = (value: string): JobId => jobId(value);

function store(ttlMs: number, maxEntries: number) {
  let now = 1_000;
  const results = new RemovedResults({ ttlMs, maxEntries, clock: () => now });
  return { results, advance: (ms: number) => (now += ms) };
}

describe('RemovedResults capacity', () => {
  test('a huge cap with few live records keeps few slots', () => {
    const { results, advance } = store(10, 100_000_000);
    for (let n = 0; n < 200_000; n++) {
      results.record(id(`s${n}`), 'q', n);
      advance(1);
    }
    expect(results.size).toBeLessThanOrEqual(10);
    expect(results.capacity).toBeLessThanOrEqual(32);
    advance(10);
    results.purgeExpired();
    expect(results.size).toBe(0);
    expect(results.capacity).toBe(16);
  });

  test('the ring grows to the cap, evicts there as before, and shrinks once expired', () => {
    const { results, advance } = store(100, 1_000);
    expect(results.capacity).toBe(0);
    for (let n = 0; n < 1_000; n++) results.record(id(`g${n}`), 'q', n);
    expect(results.capacity).toBe(1_000);

    results.record(id('over'), 'q', 'over'); // 10% evicted at the cap, oldest first
    expect(results.capacity).toBe(1_000);
    expect(results.size).toBe(901);
    expect(results.lookup(id('g99'))).toBeUndefined();
    expect(results.lookup(id('g100'))?.result).toBe(100);

    advance(100);
    expect(results.purgeExpired()).toBe(901);
    expect(results.capacity).toBe(16);
    results.record(id('after'), 'q', 'after');
    expect(results.lookup(id('after'))?.result).toBe('after');
  });

  test('a shrink of a wrapped ring keeps every indexed and pending record', () => {
    const { results, advance } = store(100, 64);
    for (let n = 0; n < 60; n++) results.record(id(`old${n}`), 'q', n); // slots 0-59
    advance(50);
    // new0-new3 take slots 60-63; at the cap 7 old records go, and new4-new7 wrap to 0-3.
    for (let n = 0; n < 8; n++) results.record(id(`new${n}`), 'q2', `new${n}`);
    expect(results.capacity).toBe(64);
    expect(results.lookup(id('new0'))?.result).toBe('new0'); // indexes every record so far
    expect(results.forget(id('new2'))).toBe(true); // a dropped slot moves too
    results.record(id('new8'), 'q2', 'new8'); // still pending at the shrink below
    results.record(id('new9'), 'q2', 'new9');

    advance(50); // every old record expires; the new ones live 50 ms more
    results.record(id('new10'), 'q2', 'new10'); // evicts the expired head, then shrinks
    expect(results.capacity).toBe(32);
    expect(results.size).toBe(10);
    for (let n = 0; n <= 10; n++) {
      const expected = { queue: 'q2', result: `new${n}`, expiresAt: n < 10 ? 1_150 : 1_200 };
      expect(results.lookup(id(`new${n}`))).toEqual(n === 2 ? undefined : expected);
    }

    advance(50);
    expect(results.purgeExpired()).toBe(9);
    expect(results.capacity).toBe(16);
    expect(results.lookup(id('new10'))?.result).toBe('new10');
    expect(results.forgetQueue('q2')).toBe(1);
    expect(results.size).toBe(0);
  });

  test('a cap below the minimum capacity is the ring size', () => {
    const { results } = store(60_000, 5);
    for (let n = 0; n < 12; n++) results.record(id(`c${n}`), 'q', n);
    expect(results.capacity).toBe(5);
    expect(results.size).toBe(5);
    for (let n = 7; n < 12; n++) expect(results.lookup(id(`c${n}`))?.result).toBe(n);
  });

  test('clear releases every slot', () => {
    const { results } = store(60_000, 1_000);
    for (let n = 0; n < 300; n++) results.record(id(`x${n}`), 'q', n);
    expect(results.capacity).toBe(512);
    results.clear();
    expect(results.capacity).toBe(0);
    results.record(id('y'), 'q', 'y');
    expect(results.capacity).toBe(16);
    expect(results.lookup(id('y'))?.result).toBe('y');
  });
});
