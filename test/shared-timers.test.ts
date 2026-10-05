import { afterEach, describe, expect, test } from 'bun:test';
import {
  clampTimerDelay,
  MAX_TIMER_DELAY_MS,
  safeDeadline,
  safeTimeout,
} from '../src/shared/timers';
import { installFakeTimers, restoreTimers } from './shared-timers-support';

// src/shared/timers.ts against a fake runtime: manual wall and monotonic clocks and
// spied native timers. Every test also checks that no delay the real runtime would
// rewrite to 1 ms (NaN, negative, above 2^31 - 1) ever reached a native timer.
// Real timers and fresh processes: test/shared-timers-real.test.ts.

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

test('the limit is 2^31 - 1 ms', () => {
  expect(MAX_TIMER_DELAY_MS).toBe(2 ** 31 - 1);
});

describe('safeTimeout', () => {
  test.each([0, 1, 1.5, 1_000, MAX])(
    '%p ms is one native timer running the callback itself',
    (ms) => {
      const t = fakeRuntime();
      let fired = 0;
      const fn = () => void fired++;
      safeTimeout(fn, ms);
      expect(t.armed).toHaveLength(1);
      expect(t.armed[0]).toMatchObject({ kind: 'timeout', ms });
      expect(t.armed[0].fn).toBe(fn); // no wrapper closure on the hot path
      t.advance(MAX);
      expect(fired).toBe(1);
      expect(t.armed).toHaveLength(1);
    }
  );

  test.each([-5, -0, -Infinity, -Number.MAX_VALUE])('%p ms behaves like 0', (ms) => {
    const t = fakeRuntime();
    let fired = 0;
    safeTimeout(() => fired++, ms);
    expect(t.delays()).toHaveLength(1);
    expect(Math.abs(t.delays()[0])).toBe(0);
    expect(fired).toBe(0); // never synchronous
    t.advance(0);
    expect(fired).toBe(1);
  });

  test('Infinity arms nothing, never fires, and its methods are no-ops', () => {
    const t = fakeRuntime();
    let fired = 0;
    const timer = safeTimeout(() => fired++, Infinity);
    expect(timer.unref()).toBe(timer);
    expect(timer.ref()).toBe(timer);
    timer.clear();
    timer.clear();
    t.advance(100 * 365 * DAY);
    expect(t.armed).toHaveLength(0);
    expect(fired).toBe(0);
  });

  test.each([NaN, undefined, 'abc', {}])('%p throws a TypeError naming the value', (ms) => {
    const t = fakeRuntime();
    expect(() => safeTimeout(() => {}, ms as number)).toThrow(TypeError);
    expect(() => safeTimeout(() => {}, ms as number)).toThrow(/safeTimeout delay must be/);
    expect(t.armed).toHaveLength(0);
  });

  test('clear() before it fires clears the native handle; repeated clears are harmless', () => {
    const t = fakeRuntime();
    let fired = 0;
    const timer = safeTimeout(() => fired++, 50);
    timer.clear();
    timer.clear();
    expect(t.cleared.map((c) => c.id)).toContain(t.last().id);
    t.advance(1_000);
    expect(fired).toBe(0);
  });

  test('clear() from inside its own callback is harmless, short and chunked', () => {
    const t = fakeRuntime();
    const calls: string[] = [];
    const short = safeTimeout(() => (short.clear(), calls.push('short')), 10);
    const long = safeTimeout(() => (long.clear(), calls.push('long')), 30 * DAY);
    t.advance(31 * DAY);
    expect(calls).toEqual(['short', 'long']);
    expect(t.pending.size).toBe(0);
  });

  test('ref() and unref() on a native-sized timer act on its handle and return the timer', () => {
    const t = fakeRuntime();
    const timer = safeTimeout(() => {}, 10);
    expect(t.last().refed).toBe(true); // ref'd by default, as native timers are
    expect(timer.unref()).toBe(timer);
    expect(t.last().refed).toBe(false);
    expect(timer.ref()).toBe(timer);
    expect(t.last().refed).toBe(true);
  });

  test('30 days is chunked against the monotonic clock and fires once, at the deadline', () => {
    const t = fakeRuntime();
    const start = t.clock.mono;
    const firedAt: number[] = [];
    const fn = () => void firedAt.push(performance.now());
    safeTimeout(fn, 30 * DAY);
    expect(t.armed[0].fn).not.toBe(fn);
    t.advance(60 * DAY);
    expect(t.delays()).toEqual([MAX, 30 * DAY - MAX]);
    expect(firedAt).toEqual([start + 30 * DAY]);
  });

  test('a wall clock jump does not move a chunked delay; an early chunk re-arms the rest', () => {
    const t = fakeRuntime();
    const start = t.clock.mono;
    let fired = 0;
    safeTimeout(() => fired++, MAX + 100);
    t.runNext({ wall: t.clock.wall + 365 * DAY }); // wall clock jumps a year ahead
    expect(fired).toBe(0);
    expect(t.delays()).toEqual([MAX, 100]);
    t.runNext({ mono: start + MAX + 99 }); // the native timer fires 1 ms early
    expect(fired).toBe(0);
    expect(t.delays().at(-1)).toBe(1);
    t.runNext();
    expect(fired).toBe(1);
    expect(t.clock.mono).toBe(start + MAX + 100);
  });

  test('clear() between chunks clears the chunk armed now; nothing fires or re-arms', () => {
    const t = fakeRuntime();
    let fired = 0;
    const timer = safeTimeout(() => fired++, 100, 20);
    t.runNext();
    t.runNext();
    const current = t.last().id;
    timer.clear();
    timer.clear();
    expect(t.cleared.map((c) => c.id)).toEqual([current]);
    expect(t.pending.size).toBe(0);
    t.advance(1_000);
    expect(fired).toBe(0);
    expect(t.armed).toHaveLength(3);
  });

  test('unref() and ref() apply to the chunk armed now and to every later chunk', () => {
    const t = fakeRuntime();
    const timer = safeTimeout(() => {}, 100, 20);
    expect(t.last().refed).toBe(true);
    timer.unref();
    expect(t.last().refed).toBe(false);
    t.runNext();
    t.runNext();
    expect(t.armed.map((a) => a.handle.refed)).toEqual([false, false, false]);
    timer.ref();
    expect(t.last().refed).toBe(true);
    t.runNext();
    expect(t.last().refed).toBe(true);
    t.advance(1_000);
    timer.unref(); // after it fired: nothing armed, nothing to touch
    expect(t.pending.size).toBe(0);
  });

  test('huge finite delays keep re-arming within the limit and never fire', () => {
    const t = fakeRuntime();
    let fired = 0;
    safeTimeout(() => fired++, Number.MAX_VALUE);
    for (let i = 0; i < 5; i++) t.runNext();
    expect(t.delays()).toEqual([MAX, MAX, MAX, MAX, MAX, MAX]);
    expect(fired).toBe(0);
  });

  test('an invalid injected chunk is rejected', () => {
    fakeRuntime();
    expect(() => safeTimeout(() => {}, 100, 0)).toThrow(RangeError);
    expect(() => safeTimeout(() => {}, 100, NaN)).toThrow(RangeError);
    expect(() => safeTimeout(() => {}, 100, MAX + 1)).toThrow(RangeError);
  });
});

describe('clampTimerDelay', () => {
  test.each([
    [0, 0],
    [5, 5],
    [1.5, 1.5],
    [MAX, MAX],
    [MAX + 1, MAX],
    [30 * DAY, MAX],
    [Infinity, MAX],
    [-1, 0],
    [-0, 0],
    [-Infinity, 0],
  ])('%p -> %p', (input, output) => {
    expect(clampTimerDelay(input)).toBe(output); // toBe: -0 must come back as +0
  });

  test.each([NaN, undefined, '5'])('%p throws a TypeError', (input) => {
    expect(() => clampTimerDelay(input as number)).toThrow(TypeError);
  });
});

describe('safeDeadline', () => {
  test('fires once when Date.now() reaches the deadline, re-reading the wall clock', () => {
    const t = fakeRuntime();
    const deadline = t.clock.wall + 50;
    let fired = 0;
    safeDeadline(() => fired++, deadline, 20);
    t.runNext({ wall: deadline - 30 });
    t.runNext({ wall: deadline - 3_600_000 }); // the wall clock was set back an hour
    expect(t.delays()).toEqual([20, 20, 20]);
    t.runNext({ wall: deadline - 1 }); // the last chunk is re-checked too
    expect(fired).toBe(0);
    expect(t.delays().at(-1)).toBe(1);
    t.runNext({ wall: deadline });
    expect(fired).toBe(1);
    expect(t.pending.size).toBe(0);
  });

  test('a deadline that fits one timer still re-checks the wall clock before firing', () => {
    const t = fakeRuntime();
    const deadline = t.clock.wall + 100;
    let fired = 0;
    safeDeadline(() => fired++, deadline);
    expect(t.delays()).toEqual([100]);
    t.runNext({ wall: deadline - 60_000 }); // a minute behind: re-armed, not fired
    expect(fired).toBe(0);
    t.advance(60_000);
    expect(fired).toBe(1);
  });

  test('a monotonic jump alone does not fire it; the wall clock decides', () => {
    const t = fakeRuntime();
    let fired = 0;
    safeDeadline(() => fired++, t.clock.wall + 10 * DAY);
    t.runNext({ wall: t.clock.wall + DAY });
    expect(fired).toBe(0);
    expect(t.delays()).toEqual([10 * DAY, 9 * DAY]);
  });

  test('a past deadline fires on the next tick, never synchronously', () => {
    const t = fakeRuntime();
    let fired = 0;
    safeDeadline(() => fired++, t.clock.wall - 1_000);
    expect(fired).toBe(0);
    expect(t.delays()).toEqual([0]);
    t.advance(0);
    expect(fired).toBe(1);
  });

  test('Infinity never fires; NaN throws a TypeError', () => {
    const t = fakeRuntime();
    let fired = 0;
    const timer = safeDeadline(() => fired++, Infinity);
    expect(timer.unref().ref()).toBe(timer);
    t.advance(100 * 365 * DAY);
    expect(t.armed).toHaveLength(0);
    expect(() => safeDeadline(() => {}, NaN)).toThrow(TypeError);
  });

  test('a 30-day deadline arms one full chunk, then the rest, and ref/unref carry over', () => {
    const t = fakeRuntime();
    let fired = 0;
    const timer = safeDeadline(() => fired++, t.clock.wall + 30 * DAY).unref();
    t.advance(31 * DAY);
    expect(t.delays()).toEqual([MAX, 30 * DAY - MAX]);
    expect(t.armed.map((a) => a.handle.refed)).toEqual([false, false]);
    expect(fired).toBe(1);
    timer.clear();
  });
});
