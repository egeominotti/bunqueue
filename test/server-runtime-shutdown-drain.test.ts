/**
 * The graceful-shutdown drain must stay bounded by SHUTDOWN_TIMEOUT_MS for any value the
 * config resolves, including values far above the native timer limit: it polls active
 * jobs once per second (Bun.sleep, which accepts any delay), never skips the drain and
 * never busy-loops. A fake clock and sleep make every case instantaneous.
 */

import { describe, expect, test } from 'bun:test';
import {
  createServerShutdown,
  type ServerShutdownResources,
  type ServerShutdownRuntime,
} from '../src/infrastructure/server/shutdownCoordinator';

const DAY = 24 * 60 * 60 * 1000;

interface DrainRun {
  readonly sleeps: number[];
  readonly inspections: number;
  readonly exits: number[];
  readonly storageStops: number;
  readonly elapsed: number;
}

/**
 * Run a shutdown whose active-job count follows `active` (the last value repeats).
 * `jumpAt` moves the fake clock to `jumpTo` ms after the start when that many
 * inspections have happened, so a deadline days away is reached in a few iterations.
 */
async function drain(
  shutdownTimeoutMs: number,
  active: number[],
  jump?: { at: number; to: number }
): Promise<DrainRun> {
  const start = 1_700_000_000_000;
  let clock = start;
  const sleeps: number[] = [];
  const exits: number[] = [];
  let inspections = 0;
  let storageStops = 0;
  const resources: ServerShutdownResources = {
    shutdownTimeoutMs,
    stopStats: () => undefined,
    stopTcpIntake: () => undefined,
    stopHttpIntake: () => undefined,
    stopTcp: () => undefined,
    stopHttp: () => undefined,
    getActiveJobs: () => {
      const count = active[Math.min(inspections, active.length - 1)];
      inspections++;
      if (jump && inspections === jump.at) clock = start + jump.to;
      return count;
    },
    emitShutdown: () => undefined,
    shutdownStorage: async () => {
      storageStops++;
    },
  };
  const runtime: Partial<ServerShutdownRuntime> = {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    stopRateLimiter: () => undefined,
    exit: (code) => exits.push(code),
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  await createServerShutdown(resources, runtime)('SIGTERM');
  return { sleeps, inspections, exits, storageStops, elapsed: clock - start };
}

describe('graceful shutdown drain with large SHUTDOWN_TIMEOUT_MS', () => {
  for (const timeout of [2 ** 31, 30 * DAY, 1e12, Number.MAX_SAFE_INTEGER]) {
    test(`waits for active jobs with a ${timeout} ms timeout (no skip, no busy loop)`, async () => {
      const run = await drain(timeout, [3, 2, 1, 0]);
      expect(run.inspections).toBe(4);
      expect(run.sleeps).toEqual([1_000, 1_000, 1_000]);
      expect(run.storageStops).toBe(1);
      expect(run.exits).toEqual([0]);
    });
  }

  test('a deadline beyond the timer limit is neither cut short nor overrun', async () => {
    const timeout = 2 ** 31 + 500;
    // Stuck jobs. The 2nd inspection moves the clock so that the 3rd one happens 200 ms
    // before the deadline: it must still inspect and wait, and the loop must end there.
    const run = await drain(timeout, [1], { at: 2, to: timeout - 1_200 });
    expect(run.inspections).toBe(3);
    expect(run.sleeps).toEqual([1_000, 1_000, 1_000]);
    expect(run.elapsed).toBeGreaterThanOrEqual(timeout);
    expect(run.elapsed).toBeLessThan(timeout + 1_000);
    expect(run.storageStops).toBe(1);
    expect(run.exits).toEqual([0]);
  });

  test('a zero timeout skips the wait but still stops storage', async () => {
    const run = await drain(0, [5]);
    expect(run.inspections).toBe(0);
    expect(run.sleeps).toEqual([]);
    expect(run.storageStops).toBe(1);
  });
});
