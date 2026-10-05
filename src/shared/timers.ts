/**
 * Timers for any delay: the single home of the runtime's timer limit.
 *
 * Bun and Node.js arm a `setTimeout`/`setInterval` whose delay lies outside
 * [0, 2^31 - 1] ms after about 1 ms and print a TimeoutOverflowWarning,
 * TimeoutNaNWarning or TimeoutNegativeWarning: a 30-day timeout fires at once and a
 * NaN interval spins. These helpers accept any delay and never hand the runtime one
 * it would rewrite:
 *
 * - a delay that fits is one native timer, with nothing added on the hot path;
 * - a longer finite delay is armed in chunks against an absolute deadline, re-measured
 *   at each chunk, so it is never early, never drifts and fires exactly once;
 * - `Infinity` arms nothing: it never fires and never keeps the process alive;
 * - `NaN` throws a TypeError. It is a programming error; boundary validation
 *   (`durations.ts`) rejects it before it reaches a timer.
 *
 * Timers are ref'd by default, as native ones are. See docs/features/shared-timers.md.
 */

/** The longest delay one native timer accepts: 2^31 - 1 ms, about 24.8 days. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A timer armed by `safeTimeout`, `safeInterval` or `safeDeadline`. */
export interface SafeTimer {
  /**
   * Cancel the timer. Idempotent, safe from inside its own callback, and always
   * clears the native timer armed at that moment (a later chunk included).
   */
  clear(): void;
  /** Keep the process alive while the timer is armed (the default), every chunk included. */
  ref(): SafeTimer;
  /** Let the process exit while the timer is armed, every later chunk included. */
  unref(): SafeTimer;
}

type NativeHandle = ReturnType<typeof setTimeout>;

/** ref/unref are optional: a browser timer handle is a plain number. */
interface Refable {
  ref?(): unknown;
  unref?(): unknown;
}

/** A delay that fits one native timer: a thin handle, no closure, no clock read. */
class NativeTimeout implements SafeTimer {
  protected readonly handle: NativeHandle;

  constructor(handle: NativeHandle) {
    this.handle = handle;
  }

  clear(): void {
    clearTimeout(this.handle);
  }

  ref(): SafeTimer {
    (this.handle as unknown as Refable).ref?.();
    return this;
  }

  unref(): SafeTimer {
    (this.handle as unknown as Refable).unref?.();
    return this;
  }
}

class NativeInterval extends NativeTimeout {
  override clear(): void {
    clearInterval(this.handle);
  }
}

const NEVER: SafeTimer = Object.freeze({
  clear(): void {},
  ref: (): SafeTimer => NEVER,
  unref: (): SafeTimer => NEVER,
});

/** A monotonic clock for relative delays, as native timers use. */
const monotonicNow = (): number => performance.now();
/** The wall clock, for deadlines given as epoch milliseconds. */
const wallNow = (): number => Date.now();

/**
 * A deadline armed one chunk at a time. Each chunk re-reads `now` and arms what
 * remains (at most `chunkMs`), so a chunk that fires early, or a wall clock set back,
 * re-arms instead of firing. A positive `periodMs` makes it repeat.
 */
class ChunkedTimer implements SafeTimer {
  private handle: NativeHandle | undefined;
  private refed = true;
  private done = false;
  private deadline: number;
  private readonly fn: () => void;
  private readonly now: () => number;
  private readonly chunkMs: number;
  private readonly periodMs: number;

  constructor(fn: () => void, deadline: number, now: () => number, chunkMs: number, periodMs = 0) {
    if (typeof fn !== 'function') throw new TypeError('Timer callback must be a function');
    this.fn = fn;
    this.deadline = deadline;
    this.now = now;
    this.chunkMs = chunkMs;
    this.periodMs = periodMs;
    this.arm(now());
  }

  clear(): void {
    this.done = true;
    if (this.handle !== undefined) clearTimeout(this.handle);
    this.handle = undefined;
  }

  ref(): SafeTimer {
    this.refed = true;
    if (this.handle !== undefined) (this.handle as unknown as Refable).ref?.();
    return this;
  }

  unref(): SafeTimer {
    this.refed = false;
    if (this.handle !== undefined) (this.handle as unknown as Refable).unref?.();
    return this;
  }

  private arm(now: number): void {
    const remaining = Math.ceil(this.deadline - now);
    const delay = remaining > this.chunkMs ? this.chunkMs : remaining > 0 ? remaining : 0;
    const handle = setTimeout(this.tick, delay);
    if (!this.refed) (handle as unknown as Refable).unref?.();
    this.handle = handle;
  }

  private readonly tick = (): void => {
    this.handle = undefined;
    if (this.done) return;
    const now = this.now();
    if (this.deadline - now > 0) {
      this.arm(now);
      return;
    }
    if (this.periodMs > 0) {
      // Re-armed before the callback, as native intervals are: clear() from inside
      // it cancels the next period, and a callback that throws keeps the interval.
      this.deadline += this.periodMs;
      if (this.deadline <= now) this.deadline = now + this.periodMs;
      this.arm(now);
    } else {
      this.done = true;
    }
    this.fn();
  };
}

function invalidDelay(what: string, value: unknown): TypeError {
  return new TypeError(`${what} must be a number of milliseconds (got ${String(value)})`);
}

/**
 * Run `fn` once after `delayMs` (monotonic time), for any delay.
 *
 * - 0..2^31 - 1: one native `setTimeout`; same cost and semantics as calling it.
 * - longer: chunks against an absolute monotonic deadline; never early, fires once.
 * - negative (or -Infinity): behaves like 0, on the next timer tick.
 * - Infinity: arms nothing, never fires, never keeps the process alive.
 * - NaN or a non-number: throws TypeError.
 *
 * `chunkMs` is a test seam (the longest native timer armed); production code omits it.
 */
export function safeTimeout(
  fn: () => void,
  delayMs: number,
  chunkMs: number = MAX_TIMER_DELAY_MS
): SafeTimer {
  // The hot path: a few comparisons the JIT folds, then the native call.
  if (
    typeof delayMs === 'number' &&
    delayMs >= 0 &&
    delayMs <= chunkMs &&
    chunkMs <= MAX_TIMER_DELAY_MS
  ) {
    return new NativeTimeout(setTimeout(fn, delayMs));
  }
  if (typeof delayMs !== 'number' || delayMs !== delayMs) {
    throw invalidDelay('safeTimeout delay', delayMs);
  }
  const limit = timerChunk(chunkMs);
  if (delayMs <= 0) return new NativeTimeout(setTimeout(fn, 0));
  if (delayMs === Infinity) return NEVER;
  return new ChunkedTimer(fn, monotonicNow() + delayMs, monotonicNow, limit);
}

/**
 * Run `fn` every `periodMs` (monotonic time), for any period.
 *
 * - (0, 2^31 - 1]: one native `setInterval`.
 * - longer: re-armed per period in chunks; never early, no burst after a stall.
 * - Infinity: arms nothing and never fires.
 * - NaN or a non-number: throws TypeError; 0 or negative: throws RangeError (a spin).
 */
export function safeInterval(
  fn: () => void,
  periodMs: number,
  chunkMs: number = MAX_TIMER_DELAY_MS
): SafeTimer {
  if (
    typeof periodMs === 'number' &&
    periodMs > 0 &&
    periodMs <= chunkMs &&
    chunkMs <= MAX_TIMER_DELAY_MS
  ) {
    return new NativeInterval(setInterval(fn, periodMs));
  }
  if (typeof periodMs !== 'number' || periodMs !== periodMs) {
    throw invalidDelay('safeInterval period', periodMs);
  }
  if (periodMs <= 0) {
    throw new RangeError(`safeInterval period must be greater than 0 ms (got ${periodMs})`);
  }
  const limit = timerChunk(chunkMs);
  if (periodMs === Infinity) return NEVER;
  return new ChunkedTimer(fn, monotonicNow() + periodMs, monotonicNow, limit, periodMs);
}

/**
 * Run `fn` once when `Date.now()` reaches `deadlineEpochMs`, for any deadline.
 *
 * Every chunk re-reads the wall clock, the last one included, so a clock set back
 * re-arms instead of firing early. A deadline already past fires on the next timer
 * tick, never synchronously. Infinity never fires; NaN throws TypeError.
 */
export function safeDeadline(
  fn: () => void,
  deadlineEpochMs: number,
  chunkMs: number = MAX_TIMER_DELAY_MS
): SafeTimer {
  if (typeof deadlineEpochMs !== 'number' || deadlineEpochMs !== deadlineEpochMs) {
    throw invalidDelay('safeDeadline deadline', deadlineEpochMs);
  }
  const limit = timerChunk(chunkMs);
  if (deadlineEpochMs === Infinity) return NEVER;
  return new ChunkedTimer(fn, deadlineEpochMs, wallNow, limit);
}

/**
 * One native delay for an abstraction that takes a single timer (a simulated clock's
 * `setTimeout`, a re-check loop): finite values clamp to [0, 2^31 - 1], Infinity to
 * 2^31 - 1 and -Infinity to 0. The caller must re-check its deadline when the timer
 * fires, because a clamped delay fires before a longer one would. NaN throws TypeError.
 */
export function clampTimerDelay(ms: number): number {
  if (typeof ms !== 'number' || ms !== ms) throw invalidDelay('Timer delay', ms);
  return ms > 0 ? (ms <= MAX_TIMER_DELAY_MS ? ms : MAX_TIMER_DELAY_MS) : 0;
}

function timerChunk(chunkMs: number): number {
  if (!(chunkMs >= 1 && chunkMs <= MAX_TIMER_DELAY_MS)) {
    throw new RangeError(`Timer chunk must be 1..${MAX_TIMER_DELAY_MS} ms (got ${chunkMs})`);
  }
  return chunkMs;
}
