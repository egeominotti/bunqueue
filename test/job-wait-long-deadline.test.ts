import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_TIMER_DELAY_MS, safeDeadline, type SafeTimer } from '../src/shared/timers';

// A wait's deadline can lie beyond the runtime's timer limit (2^31 - 1 ms, about
// 24.8 days): one setTimeout that long fires after 1 ms. The session therefore arms it
// with `safeDeadline` (src/shared/timers.ts): chunks that each fit in one timer, every
// chunk measured against the clock, and the callback runs once, never before the
// deadline. Clearing the deadline clears whichever chunk is armed. A fake clock checks
// the exact chunks; real timers with a 20 ms chunk check the same without waiting
// days; fresh processes check that a wait with a 30-day TTL keeps a script alive and
// lets it exit once it settles. test/shared-timers*.test.ts covers the helper itself.

setDefaultTimeout(30_000);

const DAY_MS = 24 * 60 * 60 * 1000;

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realNow = Date.now;

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  Date.now = realNow;
});

/** A manual clock and timer list in place of the runtime's. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; at: number }>();
  const fake = { now: 1_000_000, armed: [] as number[], handles: [] as number[] };
  const cleared: number[] = [];
  let nextId = 1;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const id = nextId++;
    pending.set(id, { fn, at: fake.now + ms });
    fake.armed.push(ms);
    fake.handles.push(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    cleared.push(id);
    pending.delete(id);
  }) as unknown as typeof clearTimeout;
  Date.now = () => fake.now;
  return {
    fake,
    cleared,
    pending,
    /** Run the earliest timer at `now`, by default its due time. */
    runNext(now?: number): void {
      const [id, timer] = [...pending].sort(([, a], [, b]) => a.at - b.at)[0];
      pending.delete(id);
      fake.now = now ?? timer.at;
      timer.fn();
    },
  };
}

test('a deadline beyond one chunk is re-armed per chunk and fires once, at the deadline', () => {
  const timers = fakeTimers();
  const deadline = timers.fake.now + 90;
  const firedAt: number[] = [];
  safeDeadline(() => firedAt.push(Date.now()), deadline, 20);

  while (timers.pending.size > 0) timers.runNext();

  expect(timers.fake.armed).toEqual([20, 20, 20, 20, 10]);
  expect(firedAt).toEqual([deadline]);
});

test('a chunk that fires early, or a clock set back, re-arms for what remains', () => {
  const timers = fakeTimers();
  const deadline = timers.fake.now + 50;
  let fired = 0;
  safeDeadline(() => fired++, deadline, 20);

  timers.runNext(deadline - 30); // first chunk, on time
  timers.runNext(deadline - 3_600_000); // the clock was set back an hour
  expect(timers.fake.armed).toEqual([20, 20, 20]);
  timers.runNext(deadline - 1); // the timer fires 1 ms early
  expect(fired).toBe(0);
  expect(timers.fake.armed.at(-1)).toBe(1);

  timers.runNext(deadline);
  expect(fired).toBe(1);
  expect(timers.pending.size).toBe(0);
});

test('clearing between chunks clears the chunk armed now, so nothing fires', () => {
  const timers = fakeTimers();
  let fired = 0;
  const deadline = safeDeadline(() => fired++, timers.fake.now + 90, 20);
  timers.runNext();
  timers.runNext();

  deadline.clear();

  expect(timers.cleared).toEqual([timers.fake.handles.at(-1) as number]);
  expect(timers.pending.size).toBe(0);
  expect(fired).toBe(0);
});

test('a deadline already past fires on the next tick, not synchronously', () => {
  const timers = fakeTimers();
  let fired = 0;
  safeDeadline(() => fired++, timers.fake.now - 1_000, 20);
  expect(fired).toBe(0);
  expect(timers.fake.armed).toEqual([0]);

  timers.runNext();
  expect(fired).toBe(1);
});

test('a 30-day deadline arms one full-size chunk, then the rest, all within the timer limit', () => {
  expect(MAX_TIMER_DELAY_MS).toBe(2 ** 31 - 1);
  const timers = fakeTimers();
  const deadline = timers.fake.now + 30 * DAY_MS;
  let fired = 0;
  safeDeadline(() => fired++, deadline);

  while (timers.pending.size > 0) timers.runNext();

  expect(timers.fake.armed).toEqual([MAX_TIMER_DELAY_MS, 30 * DAY_MS - MAX_TIMER_DELAY_MS]);
  expect(Math.max(...timers.fake.armed)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
  expect(fired).toBe(1);
});

/** Counts the timers armed with the runtime's own setTimeout until restored. */
function countTimers(): number[] {
  const delays: number[] = [];
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    delays.push(ms);
    return realSetTimeout(fn, ms);
  }) as unknown as typeof setTimeout;
  return delays;
}

test('with real timers and a 20 ms chunk, the callback fires once, not before the deadline', async () => {
  const delays = countTimers();
  const deadline = Date.now() + 100;
  const firedAt: number[] = [];
  const fired = Promise.withResolvers<null>();
  safeDeadline(
    () => {
      firedAt.push(Date.now());
      fired.resolve(null);
    },
    deadline,
    20
  );

  await fired.promise;
  await Bun.sleep(100); // a second call would land here

  expect(firedAt).toHaveLength(1);
  expect(firedAt[0]).toBeGreaterThanOrEqual(deadline);
  // On time that is 5 chunks; a loaded runner can stretch each one, never shrink it.
  expect(delays.length).toBeGreaterThanOrEqual(2);
  expect(Math.max(...delays)).toBeLessThanOrEqual(20);
});

test('with real timers, clearing after a re-arm keeps the callback from firing', async () => {
  const delays = countTimers();
  const deadline = Date.now() + 600;
  let fired = 0;
  const timer: SafeTimer = safeDeadline(() => fired++, deadline, 20);
  while (delays.length < 3) await Bun.sleep(1);

  timer.clear();
  const armsAtClear = delays.length;
  await Bun.sleep(Math.max(0, deadline - Date.now()) + 100);

  expect(fired).toBe(0);
  expect(delays.length).toBe(armsAtClear);
});

test('with real timers, a deadline already past fires promptly', async () => {
  const started = Date.now();
  const fired = Promise.withResolvers<number>();
  safeDeadline(() => fired.resolve(Date.now()), started - 5_000, 20);
  expect((await fired.promise) - started).toBeLessThan(1_000);
});

/** Run `body` (an ES module source) in a fresh Bun process; at most 20 s. */
async function runScript(
  body: string
): Promise<{ exited: number | string; output: string; ms: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'job-wait-long-deadline-'));
  try {
    const script = join(dir, 'script.ts');
    writeFileSync(script, body);
    const started = Date.now();
    const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    const exited = await Promise.race([child.exited, Bun.sleep(20_000).then(() => 'running')]);
    if (exited === 'running') child.kill(9);
    return { exited, output: await new Response(child.stdout).text(), ms: Date.now() - started };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sessionModule = JSON.stringify(join(import.meta.dir, '../src/client/job-wait/session.ts'));
const schedulerModule = JSON.stringify(
  join(import.meta.dir, '../src/client/job-wait/readScheduler.ts')
);
const thirtyDayWait = `import { JobWaitSession } from ${sessionModule};
import { readSchedulerFor } from ${schedulerModule};
process.on('warning', (warning) => console.log('warning', warning.name));
const wait = new JobWaitSession({
  reader: { read: () => Promise.resolve(null) },
  finish: (outcome) => console.log('settled', JSON.stringify(outcome)),
  scheduler: readSchedulerFor({}, 20),
});
wait.armDeadline({ deadline: Date.now() + ${30 * DAY_MS}, message: 'timed out' });
`;

test('a wait with a 30-day TTL keeps a script alive and does not settle early', async () => {
  // The unref'd probe runs only if the deadline's own timer keeps the process alive.
  const { exited, output } = await runScript(
    `${thirtyDayWait}
const probe = setTimeout(() => {
  console.log('alive');
  process.exit(0);
}, 1_500);
probe.unref();
`
  );
  expect(exited).toBe(0);
  expect(output).toContain('alive');
  expect(output).not.toContain('settled');
  expect(output).not.toContain('TimeoutOverflowWarning');
});

test('a wait with a 30-day TTL that settles lets the script exit', async () => {
  // A deadline chunk left armed would keep the process alive for 24 days.
  const { exited, output, ms } = await runScript(
    `${thirtyDayWait}
setTimeout(() => wait.settle({ value: 'done' }), 100);
`
  );
  expect(exited).toBe(0);
  expect(output).toContain('settled {"value":"done"}');
  expect(ms).toBeLessThan(10_000);
});
