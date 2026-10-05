/**
 * A fake runtime for test/shared-timers.test.ts: manual wall and monotonic clocks plus
 * spied setTimeout/clearTimeout/setInterval/clearInterval whose handles track
 * ref/unref. Every delay handed to the fake is recorded, and one the real runtime
 * would rewrite to 1 ms (NaN, negative, above 2^31 - 1) is also listed in `invalid`.
 * `restoreTimers()` puts the real functions back; call it from afterEach.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIMIT = 2_147_483_647;

const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  dateNow: Date.now,
  perfNow: performance.now,
};

export function restoreTimers(): void {
  globalThis.setTimeout = real.setTimeout;
  globalThis.clearTimeout = real.clearTimeout;
  globalThis.setInterval = real.setInterval;
  globalThis.clearInterval = real.clearInterval;
  Date.now = real.dateNow;
  performance.now = real.perfNow;
}

export interface FakeHandle {
  readonly id: number;
  refed: boolean;
  ref(): FakeHandle;
  unref(): FakeHandle;
}

type Kind = 'timeout' | 'interval';

interface Pending {
  handle: FakeHandle;
  fn: () => void;
  at: number;
  period: number | null;
}

export interface Armed {
  kind: Kind;
  ms: number;
  fn: () => void;
  handle: FakeHandle;
}

export function installFakeTimers() {
  const clock = { wall: 1_700_000_000_000, mono: 5_000 };
  const pending = new Map<number, Pending>();
  const armed: Armed[] = [];
  const cleared: Array<{ kind: Kind; id: number }> = [];
  const invalid: unknown[] = [];
  let nextId = 1;

  const schedule = (kind: Kind, fn: () => void, ms: number): FakeHandle => {
    if (typeof ms !== 'number' || !(ms >= 0 && ms <= LIMIT)) invalid.push(ms);
    const handle: FakeHandle = {
      id: nextId++,
      refed: true,
      ref: () => ((handle.refed = true), handle),
      unref: () => ((handle.refed = false), handle),
    };
    const delay = ms >= 0 && ms <= LIMIT ? ms : 1;
    pending.set(handle.id, {
      handle,
      fn,
      at: clock.mono + delay,
      period: kind === 'interval' ? Math.max(1, delay) : null,
    });
    armed.push({ kind, ms, fn, handle });
    return handle;
  };
  const cancel = (kind: Kind) => (handle: FakeHandle | undefined) => {
    if (!handle) return;
    cleared.push({ kind, id: handle.id });
    pending.delete(handle.id);
  };
  globalThis.setTimeout = ((fn: () => void, ms: number) =>
    schedule('timeout', fn, ms)) as unknown as typeof setTimeout;
  globalThis.setInterval = ((fn: () => void, ms: number) =>
    schedule('interval', fn, ms)) as unknown as typeof setInterval;
  globalThis.clearTimeout = cancel('timeout') as unknown as typeof clearTimeout;
  globalThis.clearInterval = cancel('interval') as unknown as typeof clearInterval;
  Date.now = () => clock.wall;
  performance.now = () => clock.mono;

  const earliest = (): Pending | undefined =>
    [...pending.values()].sort((a, b) => a.at - b.at || a.handle.id - b.handle.id)[0];

  /** Fire one timer with the monotonic clock at `mono`; the wall clock moves alike. */
  const fire = (timer: Pending, mono: number, wall?: number): void => {
    clock.wall = wall ?? clock.wall + (mono - clock.mono);
    clock.mono = mono;
    if (timer.period === null) pending.delete(timer.handle.id);
    else timer.at = mono + timer.period;
    timer.fn();
  };

  return {
    clock,
    pending,
    armed,
    cleared,
    invalid,
    /** The delays armed so far, in order. */
    delays: (): number[] => armed.map((entry) => entry.ms),
    /** The handle armed last. */
    last: (): FakeHandle => armed[armed.length - 1].handle,
    /** Run the earliest timer, by default at its due time; `wall`/`mono` override. */
    runNext(at: { mono?: number; wall?: number } = {}): void {
      const timer = earliest();
      if (!timer) throw new Error('no pending timer');
      fire(timer, at.mono ?? timer.at, at.wall);
    },
    /** Move both clocks forward by `ms`, running every timer due on the way. */
    advance(ms: number): void {
      const target = clock.mono + ms;
      for (let fired = 0; ; fired++) {
        if (fired > 10_000) throw new Error('fake timers: storm, over 10000 firings');
        const timer = earliest();
        if (!timer || timer.at > target) break;
        fire(timer, Math.max(clock.mono, timer.at));
      }
      clock.wall += target - clock.mono;
      clock.mono = target;
    },
  };
}

/** Run `body` (an ES module source) in a fresh Bun process; at most 20 s. */
export async function runScript(
  body: string
): Promise<{ exited: number | string; output: string; ms: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'shared-timers-'));
  try {
    const script = join(dir, 'script.ts');
    writeFileSync(script, body);
    const started = Date.now();
    const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    const exited = await Promise.race([child.exited, Bun.sleep(20_000).then(() => 'running')]);
    if (exited === 'running') child.kill(9);
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exited, output: out + err, ms: Date.now() - started };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
