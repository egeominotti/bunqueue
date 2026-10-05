/**
 * Repro: SandboxedWorker durations that the runtime rewrites to about 1 ms.
 *
 * Bun and Node.js arm setTimeout/setInterval after ~1 ms when the delay is NaN,
 * ±Infinity, negative or above 2^31 - 1 ms, and Bun.sleep resolves NaN, negative, 0
 * and sub-millisecond delays at once. Before the fix:
 *
 * 1. runtime/dispatch.ts: a `timeout` of Infinity or above the limit failed every
 *    job after ~1 ms (a per-job path).
 * 2. runtime/lifecycle.ts: `autoStartPollMs` had no guard, so the idle watch sent a
 *    Count request about 870 times per second.
 * 3. runtime/recovery.ts: a NaN `heartbeatInterval` slipped past the `<= 0` guard and
 *    the heartbeat interval spun.
 * 4. runtime/pool.ts: a NaN or negative `pollInterval` made Bun.sleep resolve at once,
 *    so the pull loop ran hot whenever every thread was busy.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { SandboxedProbe, fakeBroker, type ProbeOptions } from './sandboxed-timers-support';
import { installFakeTimers, restoreTimers } from './shared-timers-support';

/** About 34.7 days: above the 2^31 - 1 ms (24.8 days) native timer limit. */
const LONG = 3_000_000_000;
const probes: SandboxedProbe[] = [];

afterEach(async () => {
  for (const probe of probes.splice(0)) await probe.stop(true);
  restoreTimers();
});

function probe(options: ProbeOptions): SandboxedProbe {
  const created = new SandboxedProbe(options);
  probes.push(created);
  return created;
}

/** The probe, or the error its constructor threw. */
function tryProbe(options: ProbeOptions): SandboxedProbe | Error {
  try {
    return probe(options);
  } catch (error) {
    return error as Error;
  }
}

function expectRejected(created: SandboxedProbe | Error, option: string): created is Error {
  if (!(created instanceof Error)) return false;
  expect(created).toBeInstanceOf(RangeError);
  expect(created.message).toStartWith(`SandboxedWorker: ${option} must be`);
  return true;
}

describe('timeout (defect 1, per job)', () => {
  for (const timeout of [LONG, Infinity]) {
    test(`timeout ${timeout} does not time the job out after about 1 ms`, async () => {
      const { calls, manager } = fakeBroker();
      probe({ manager, timeout }).dispatchToSilentThread();
      await Bun.sleep(40);
      expect(calls.failures).toEqual([]);
    });
  }

  test('a timeout above the limit fires exactly when due, through in-range timers', () => {
    const timers = installFakeTimers();
    const { calls, manager } = fakeBroker();
    probe({ manager, timeout: LONG }).dispatchToSilentThread();
    expect(timers.invalid).toEqual([]);
    timers.advance(LONG - 1);
    expect(calls.failures).toEqual([]);
    timers.advance(1);
    expect(calls.failures).toEqual([`Job timed out after ${LONG}ms`]);
  });

  test('an in-range timeout is one native timer with exactly that delay', () => {
    const timers = installFakeTimers();
    const { manager } = fakeBroker();
    probe({ manager, timeout: 30_000 }).dispatchToSilentThread();
    expect(timers.delays()).toEqual([30_000]);
  });

  test('timeout 0 still disables the per-job timer (documented)', () => {
    const timers = installFakeTimers();
    const { manager } = fakeBroker();
    probe({ manager, timeout: 0 }).dispatchToSilentThread();
    expect(timers.delays()).toEqual([]);
  });
});

describe('autoStartPollMs (defect 2)', () => {
  test('autoStartPollMs NaN is rejected instead of flooding Count', async () => {
    const { calls, manager } = fakeBroker();
    const created = tryProbe({ manager, autoStart: true, autoStartPollMs: NaN });
    if (expectRejected(created, 'autoStartPollMs')) return;
    await created.stopAndWatchQueue();
    await Bun.sleep(50);
    throw new Error(`autoStartPollMs NaN was accepted: ${calls.counts} Count requests in 50 ms`);
  });

  test('a long autoStartPollMs is honoured instead of polling every ~1 ms', async () => {
    const { calls, manager } = fakeBroker();
    await probe({ manager, autoStart: true, autoStartPollMs: LONG }).stopAndWatchQueue();
    await Bun.sleep(50);
    expect(calls.counts).toBe(0);
  });

  test('the idle watch polls exactly every autoStartPollMs, through in-range timers', async () => {
    const timers = installFakeTimers();
    const { calls, manager } = fakeBroker();
    await probe({ manager, autoStart: true, autoStartPollMs: LONG }).stopAndWatchQueue();
    expect(timers.invalid).toEqual([]);
    timers.advance(LONG - 1);
    expect(calls.counts).toBe(0);
    timers.advance(1);
    expect(calls.counts).toBe(1);
  });
});

describe('heartbeatInterval (defect 3)', () => {
  test('heartbeatInterval NaN is rejected instead of spinning', async () => {
    const { manager } = fakeBroker();
    const created = tryProbe({ manager, heartbeatInterval: NaN });
    if (expectRejected(created, 'heartbeatInterval')) return;
    created.armHeartbeat();
    await Bun.sleep(50);
    throw new Error(`heartbeatInterval NaN was accepted: ${created.heartbeatTicks} beats in 50 ms`);
  });

  test('a long heartbeatInterval is honoured instead of beating every ~1 ms', async () => {
    const { manager } = fakeBroker();
    const created = probe({ manager, heartbeatInterval: LONG });
    created.armHeartbeat();
    await Bun.sleep(50);
    expect(created.heartbeatTicks).toBe(0);
  });

  test('a long heartbeatInterval beats once per period, through in-range timers', () => {
    const timers = installFakeTimers();
    const { manager } = fakeBroker();
    const created = probe({ manager, heartbeatInterval: LONG });
    created.armHeartbeat();
    expect(timers.invalid).toEqual([]);
    timers.advance(LONG - 1);
    expect(created.heartbeatTicks).toBe(0);
    timers.advance(1);
    expect(created.heartbeatTicks).toBe(1);
    timers.advance(LONG);
    expect(created.heartbeatTicks).toBe(2);
  });

  test.each([0, -1, -Infinity])('heartbeatInterval %p still disables heartbeats', (value) => {
    const { manager } = fakeBroker();
    const created = probe({ manager, heartbeatInterval: value });
    created.armHeartbeat();
    expect(created.heartbeatArmed).toBe(false);
  });
});

describe('pollInterval (defect 4)', () => {
  test('pollInterval NaN is rejected instead of running the pull loop hot', async () => {
    const { manager } = fakeBroker();
    const created = tryProbe({ manager, pollInterval: NaN });
    if (expectRejected(created, 'pollInterval')) return;
    const loop = created.runPullLoopWithBusyThread();
    await Bun.sleep(50);
    await created.stop(true);
    throw new Error(`pollInterval NaN was accepted: ${loop.passes()} pull-loop passes in 50 ms`);
  });

  test('the pull loop sleeps pollInterval between passes while every thread is busy', async () => {
    const { manager } = fakeBroker();
    const created = probe({ manager, pollInterval: 20 });
    const started = performance.now();
    const loop = created.runPullLoopWithBusyThread();
    await Bun.sleep(200);
    // stop() ends the loop synchronously (running = false, wait woken), so no pass
    // can start between this reading and the stop.
    const elapsed = performance.now() - started;
    const stopping = created.stop(true);
    const passes = loop.passes();
    await stopping;
    // One pass per 20 ms wait, plus the first; a hot loop would make thousands.
    expect(passes).toBeGreaterThanOrEqual(2);
    expect(passes).toBeLessThanOrEqual(Math.ceil(elapsed / 20) + 1);
  });

  test('a long pollInterval is honoured, and stop() does not wait it out', async () => {
    const { manager } = fakeBroker();
    const created = probe({ manager, pollInterval: LONG });
    const loop = created.runPullLoopWithBusyThread();
    await Bun.sleep(30);
    expect(loop.passes()).toBe(1);
    const outcome = await Promise.race([
      created.stop(true).then(() => 'stopped'),
      Bun.sleep(1_000).then(() => 'stop() still waiting after 1 s'),
    ]);
    expect(outcome).toBe('stopped');
  });

  test('the poll sleep hands native timers only in-range delays (portable runtime)', async () => {
    // bunqueue-client maps Bun.sleep to a native setTimeout on Node.js and Deno.
    const timers = installFakeTimers();
    const { manager } = fakeBroker();
    const created = probe({ manager, pollInterval: LONG });
    created.runPullLoopWithBusyThread();
    await Bun.sleep(5);
    expect(timers.invalid).toEqual([]);
    await created.stop(true);
  });
});
