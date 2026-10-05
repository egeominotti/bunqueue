import { afterEach, expect, test } from 'bun:test';
import { MAX_TIMER_DELAY_MS, safeInterval } from '../src/shared/timers';
import { installFakeTimers, restoreTimers } from './shared-timers-support';

// safeInterval (src/shared/timers.ts) against a fake runtime: manual clocks and
// spied native timers. No delay the real runtime would rewrite to 1 ms may ever reach
// a native timer. Real timers and fresh processes: test/shared-timers-real.test.ts.

const MAX = MAX_TIMER_DELAY_MS;
const DAY = 24 * 60 * 60 * 1000;
let fake: ReturnType<typeof installFakeTimers> | undefined;

function fakeRuntime() {
  fake = installFakeTimers();
  return fake;
}

afterEach(() => {
  const invalid = fake?.invalid ?? [];
  fake = undefined;
  restoreTimers();
  expect(invalid).toEqual([]);
});

test.each([0.5, 1, 1_000, MAX])('a %p ms period is one native setInterval', (ms) => {
  const t = fakeRuntime();
  let ticks = 0;
  const fn = () => void ticks++;
  const timer = safeInterval(fn, ms);
  expect(t.armed).toHaveLength(1);
  expect(t.armed[0]).toMatchObject({ kind: 'interval', ms });
  expect(t.armed[0].fn).toBe(fn);
  timer.clear();
  timer.clear();
  expect(t.cleared.length).toBeGreaterThan(0);
  expect(t.cleared.every((c) => c.kind === 'interval' && c.id === t.armed[0].handle.id)).toBe(true);
});

test('a native interval ticks until cleared, and ref/unref act on its handle', () => {
  const t = fakeRuntime();
  let ticks = 0;
  const timer = safeInterval(() => ticks++, 10);
  expect(t.last().refed).toBe(true);
  expect(timer.unref()).toBe(timer);
  expect(t.last().refed).toBe(false);
  expect(timer.ref()).toBe(timer);
  expect(t.last().refed).toBe(true);
  t.advance(35);
  expect(ticks).toBe(3);
  timer.clear();
  t.advance(100);
  expect(ticks).toBe(3);
});

test.each([0, -0, -1, -Infinity])('a %p ms period throws a RangeError (it would spin)', (ms) => {
  const t = fakeRuntime();
  expect(() => safeInterval(() => {}, ms)).toThrow(RangeError);
  expect(() => safeInterval(() => {}, ms)).toThrow(/greater than 0/);
  expect(t.armed).toHaveLength(0);
});

test.each([NaN, undefined, 'abc'])('a %p period throws a TypeError', (ms) => {
  const t = fakeRuntime();
  expect(() => safeInterval(() => {}, ms as number)).toThrow(TypeError);
  expect(t.armed).toHaveLength(0);
});

test('an Infinity period arms nothing and never ticks', () => {
  const t = fakeRuntime();
  let ticks = 0;
  const timer = safeInterval(() => ticks++, Infinity);
  expect(timer.unref().ref()).toBe(timer);
  timer.clear();
  t.advance(100 * 365 * DAY);
  expect(t.armed).toHaveLength(0);
  expect(ticks).toBe(0);
});

test('a 30-day period ticks every 30 days of monotonic time, chunked within the limit', () => {
  const t = fakeRuntime();
  const start = t.clock.mono;
  const ticks: number[] = [];
  const timer = safeInterval(() => void ticks.push(performance.now() - start), 30 * DAY);
  expect(t.armed[0].kind).toBe('timeout');
  t.advance(95 * DAY);
  expect(ticks).toEqual([30 * DAY, 60 * DAY, 90 * DAY]);
  expect(Math.max(...t.delays())).toBeLessThanOrEqual(MAX);
  timer.clear();
  expect(t.pending.size).toBe(0);
});

test('the next period is armed before the callback: clear() inside it stops the interval', () => {
  const t = fakeRuntime();
  let ticks = 0;
  let pendingInCallback = -1;
  const timer = safeInterval(
    () => {
      ticks++;
      pendingInCallback = t.pending.size;
      timer.clear();
    },
    100,
    20
  );
  t.advance(1_000);
  expect(ticks).toBe(1);
  expect(pendingInCallback).toBe(1);
  expect(t.pending.size).toBe(0);
});

test('a callback that throws keeps the interval armed, as a native interval does', () => {
  const t = fakeRuntime();
  let ticks = 0;
  const timer = safeInterval(
    () => {
      ticks++;
      throw new Error('boom');
    },
    100,
    20
  );
  expect(() => t.advance(100)).toThrow('boom');
  expect(t.pending.size).toBe(1);
  expect(() => t.advance(100)).toThrow('boom');
  expect(ticks).toBe(2);
  timer.clear();
});

test('a stall longer than several periods ticks once, then one period later; no burst', () => {
  const t = fakeRuntime();
  const start = t.clock.mono;
  const ticks: number[] = [];
  const timer = safeInterval(() => void ticks.push(performance.now() - start), 100, 20);
  t.runNext({ mono: start + 1_000 }); // the process was stalled for ten periods
  expect(ticks).toEqual([1_000]);
  t.advance(250);
  expect(ticks).toEqual([1_000, 1_100, 1_200]);
  timer.clear();
});

test('unref() and ref() carry over every chunk of every period', () => {
  const t = fakeRuntime();
  let ticks = 0;
  const timer = safeInterval(() => ticks++, 50, 20).unref();
  t.advance(120);
  expect(ticks).toBe(2);
  expect(t.armed.every((a) => !a.handle.refed)).toBe(true);
  timer.ref();
  const before = t.armed.length;
  t.advance(60);
  expect(t.armed.slice(before - 1).every((a) => a.handle.refed)).toBe(true);
  timer.clear();
});
