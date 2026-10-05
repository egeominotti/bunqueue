import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { join } from 'node:path';
import { safeInterval, safeTimeout } from '../src/shared/timers';
import { runScript } from './shared-timers-support';

// src/shared/timers.ts with real timers (tiny injected chunks, so long delays are
// exercised in milliseconds) and in fresh Bun processes, where nothing an earlier test
// did can hide a runtime warning (Bun prints an identical warning only once).

setDefaultTimeout(30_000);

const DAY = 24 * 60 * 60 * 1000;
const realSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
});

/** Count the delays armed with the runtime's setTimeout until restored. */
function countTimers(): number[] {
  const delays: number[] = [];
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    delays.push(ms);
    return realSetTimeout(fn, ms);
  }) as unknown as typeof setTimeout;
  return delays;
}

test('a chunked timeout fires once, never before its delay, every chunk within the cap', async () => {
  const delays = countTimers();
  const start = performance.now();
  const firedAt: number[] = [];
  const fired = Promise.withResolvers<null>();
  safeTimeout(
    () => {
      firedAt.push(performance.now());
      fired.resolve(null);
    },
    100,
    20
  );
  await fired.promise;
  await Bun.sleep(100); // a second call would land here
  expect(firedAt).toHaveLength(1);
  expect(firedAt[0] - start).toBeGreaterThanOrEqual(100);
  expect(delays.length).toBeGreaterThanOrEqual(2);
  expect(Math.max(...delays)).toBeLessThanOrEqual(20);
});

test('clearing a chunked timeout after a re-arm keeps it from firing or re-arming', async () => {
  const delays = countTimers();
  let fired = 0;
  const timer = safeTimeout(() => fired++, 400, 20);
  for (let i = 0; delays.length < 3 && i < 2_000; i++) await Bun.sleep(1);
  expect(delays.length).toBeGreaterThanOrEqual(3);
  timer.clear();
  const armsAtClear = delays.length;
  await Bun.sleep(500);
  expect(fired).toBe(0);
  expect(delays.length).toBe(armsAtClear);
});

test('a chunked interval keeps its period and stops when cleared from its callback', async () => {
  const start = performance.now();
  const ticks: number[] = [];
  const done = Promise.withResolvers<null>();
  const timer = safeInterval(
    () => {
      ticks.push(performance.now() - start);
      if (ticks.length === 3) {
        timer.clear();
        done.resolve(null);
      }
    },
    60,
    20
  );
  await done.promise;
  await Bun.sleep(150); // a fourth tick would land here
  expect(ticks).toHaveLength(3);
  ticks.forEach((at, i) => expect(at).toBeGreaterThanOrEqual(60 * (i + 1)));
});

const timersModule = JSON.stringify(join(import.meta.dir, '../src/shared/timers.ts'));
const preamble = `import { clampTimerDelay, safeDeadline, safeInterval, safeTimeout, MAX_TIMER_DELAY_MS } from ${timersModule};
process.on('warning', (warning) => console.log('warning', warning.name));
`;

test('a 30-day timeout keeps a script alive, without a warning, and does not fire', async () => {
  // The unref'd probe runs only if the 30-day timer keeps the process alive.
  const { exited, output } = await runScript(`${preamble}
safeTimeout(() => console.log('fired'), ${30 * DAY});
const probe = setTimeout(() => {
  console.log('alive');
  process.exit(0);
}, 1_000);
probe.unref();
`);
  expect(output).toContain('alive');
  expect(output).not.toContain('fired');
  expect(output).not.toContain('warning');
  expect(exited).toBe(0);
});

test("unref'd 30-day timers (timeout, interval, deadline) let a script exit", async () => {
  const { exited, output, ms } = await runScript(`${preamble}
safeTimeout(() => console.log('fired'), ${30 * DAY}).unref();
safeInterval(() => console.log('fired'), ${30 * DAY}).unref();
safeDeadline(() => console.log('fired'), Date.now() + ${30 * DAY}).unref();
console.log('armed');
`);
  expect(output).toContain('armed');
  expect(output).not.toContain('fired');
  expect(output).not.toContain('warning');
  expect(exited).toBe(0);
  expect(ms).toBeLessThan(10_000);
});

test('a 30-day interval does not spin: 0 ticks in 300 ms, and clear() lets the script exit', async () => {
  const { exited, output, ms } = await runScript(`${preamble}
let ticks = 0;
const timers = [
  safeInterval(() => ticks++, ${30 * DAY}),
  safeInterval(() => ticks++, 2 ** 31),
  safeInterval(() => ticks++, MAX_TIMER_DELAY_MS),
];
setTimeout(() => {
  console.log('ticks', ticks);
  for (const timer of timers) timer.clear();
}, 300);
`);
  expect(output).toContain('ticks 0');
  expect(output).not.toContain('warning');
  expect(exited).toBe(0);
  expect(ms).toBeLessThan(10_000);
});

test('no helper ever makes the runtime emit a Timeout warning, whatever the value', async () => {
  const { exited, output } = await runScript(`${preamble}
const noop = () => {};
const values = [-5, -0, -Infinity, 0, 0.5, MAX_TIMER_DELAY_MS, 2 ** 31, ${30 * DAY}, Infinity, Number.MAX_VALUE];
const timers = [];
for (const ms of values) {
  timers.push(safeTimeout(noop, ms), safeDeadline(noop, Date.now() + ms));
  timers.push({ clear: ((h) => () => clearTimeout(h))(setTimeout(noop, clampTimerDelay(ms))) });
  if (ms >= 1) timers.push(safeInterval(noop, ms));
}
const errors = [];
for (const arm of [
  () => safeTimeout(noop, NaN),
  () => safeInterval(noop, NaN),
  () => safeInterval(noop, 0),
  () => safeInterval(noop, -1),
  () => safeDeadline(noop, NaN),
  () => clampTimerDelay(NaN),
]) {
  try {
    arm();
    errors.push('none');
  } catch (error) {
    errors.push(error.name);
  }
}
console.log('errors', errors.join(','));
setTimeout(() => {
  for (const timer of timers) timer.clear();
  process.emitWarning('the listener works', 'ControlWarning');
}, 50);
`);
  expect(output).toContain('errors TypeError,TypeError,RangeError,RangeError,TypeError,TypeError');
  expect(output).toContain('warning ControlWarning');
  expect(output).not.toMatch(/warning Timeout/);
  expect(output).not.toContain('Timeout duration was set to 1');
  expect(exited).toBe(0);
});
