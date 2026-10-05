/**
 * Repro: `WorkerOptions.heartbeatInterval` reached three native `setInterval` calls
 * guarded only by `> 0`: the embedded per-job heartbeat (`runtime/control.ts`), the TCP
 * JobHeartbeat timer (`workerHeartbeat.ts`) and the worker-registration heartbeat
 * (`runtime/execution.ts`). The runtime arms an interval above 2^31 - 1 ms, or of
 * Infinity, after about 1 ms, so a 34-day interval flooded the broker with heartbeats
 * at about 870 per second. NaN and negative values disabled heartbeats; they still do,
 * as 2.9.10's `> 0` guard read them (test/repro-compat-client-worker.test.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Worker, shutdownManager } from '../src/client';
import { getSharedManager } from '../src/client/manager';
import { MAX_TIMER_DELAY_MS } from '../src/shared/timers';
import { MODES, closeHarness, startHarness, type CoreE2eHarness } from './docs-guide-support';

/** About 34.7 days: above the 2^31 - 1 ms that one native timer accepts. */
const BEYOND_TIMER_LIMIT = 3_000_000_000;

const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const restores: Array<() => void> = [];
let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;
  for (const restore of restores.splice(0).reverse()) restore();
  await closeHarness(harness);
  harness = null;
  shutdownManager();
});

/** Record every delay the runtime would rewrite to 1 ms; the real timers still run. */
function recordInvalidTimerDelays(): unknown[] {
  const invalid: unknown[] = [];
  const check = (ms: unknown) => {
    if (typeof ms !== 'number' || !(ms >= 0 && ms <= MAX_TIMER_DELAY_MS)) invalid.push(ms);
  };
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
    check(ms ?? 0);
    return realSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout;
  globalThis.setInterval = ((fn: () => void, ms?: number, ...args: unknown[]) => {
    check(ms ?? 0);
    return realSetInterval(fn, ms, ...args);
  }) as typeof setInterval;
  return invalid;
}

interface HeartbeatCounts {
  worker: number;
  job: number;
}

/** Count registration and per-job heartbeats that reach the broker. */
function countHeartbeats(active: CoreE2eHarness, worker: Worker): HeartbeatCounts {
  const counts: HeartbeatCounts = { worker: 0, job: 0 };
  if (active.mode === 'embedded') {
    const manager = getSharedManager(active.dataPath);
    const workers = manager.workerManager;
    const workerHeartbeat = workers.heartbeat;
    const jobHeartbeat = manager.jobHeartbeat;
    workers.heartbeat = (...args: Parameters<typeof workerHeartbeat>) => {
      counts.worker++;
      return workerHeartbeat.apply(workers, args);
    };
    manager.jobHeartbeat = (...args: Parameters<typeof jobHeartbeat>) => {
      counts.job++;
      return jobHeartbeat.apply(manager, args);
    };
    restores.push(() => {
      workers.heartbeat = workerHeartbeat;
      manager.jobHeartbeat = jobHeartbeat;
    });
    return counts;
  }
  const pool = (worker as unknown as { tcp: { send: (cmd: Record<string, unknown>) => unknown } })
    .tcp;
  const send = pool.send.bind(pool);
  pool.send = (cmd: Record<string, unknown>, ...rest: unknown[]) => {
    if (cmd.cmd === 'Heartbeat') counts.worker++;
    if (cmd.cmd === 'JobHeartbeat' || cmd.cmd === 'JobHeartbeatB') counts.job++;
    return (send as (...all: unknown[]) => unknown)(cmd, ...rest);
  };
  return counts;
}

for (const mode of MODES) {
  describe(`Worker heartbeatInterval beyond the timer limit [${mode}]`, () => {
    test('sends no heartbeat early and never arms an out-of-range native timer', async () => {
      harness = await startHarness('worker-heartbeat-interval', mode);
      const queue = harness.queue('long-interval');
      const started = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const worker = new Worker(
        queue.name,
        async () => {
          started.resolve(undefined);
          await release.promise;
          return 'done';
        },
        harness.workerOptions({ heartbeatInterval: BEYOND_TIMER_LIMIT, autorun: false })
      );
      harness.addCleanup(async () => {
        release.resolve(undefined);
        await worker.close(true);
      });
      const counts = countHeartbeats(harness, worker);
      const invalid = recordInvalidTimerDelays();

      worker.run();
      await queue.add('held', {});
      await started.promise;
      await Bun.sleep(60);
      const seen = { invalidDelays: [...invalid], ...counts };
      release.resolve(undefined);

      expect(seen).toEqual({ invalidDelays: [], worker: 0, job: 0 });
    });

    test('a valid interval still renews the lease and the registration', async () => {
      harness = await startHarness('worker-heartbeat-interval', mode);
      const queue = harness.queue('short-interval');
      const started = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const worker = new Worker(
        queue.name,
        async () => {
          started.resolve(undefined);
          await release.promise;
          return 'done';
        },
        harness.workerOptions({ heartbeatInterval: 15, autorun: false })
      );
      harness.addCleanup(async () => {
        release.resolve(undefined);
        await worker.close(true);
      });
      const counts = countHeartbeats(harness, worker);

      worker.run();
      await queue.add('held', {});
      await started.promise;
      await Bun.sleep(100);
      const seen = { ...counts };
      release.resolve(undefined);

      expect(seen.worker).toBeGreaterThanOrEqual(2);
      expect(seen.job).toBeGreaterThanOrEqual(2);
    });
  });
}

describe('Worker heartbeatInterval validation', () => {
  const build = (heartbeatInterval: unknown) =>
    new Worker('repro-heartbeat-validation', async () => 1, {
      embedded: true,
      autorun: false,
      heartbeatInterval: heartbeatInterval as number,
    });

  // 0, a negative value and NaN disable (2.9.10's `> 0` guard); any other value must be
  // finite and >= 1, as in SandboxedWorker. A positive interval below 1 ms ticked about
  // every millisecond, flooding the broker, and so did Infinity.
  test.each([
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [0.5, '0.5'],
    [0.999, '0.999'],
    [Number.MIN_VALUE, String(Number.MIN_VALUE)],
  ])('rejects %p at construction, naming the option', (value, shown) => {
    expect(() => build(value)).toThrow(
      new RangeError(
        `Worker: heartbeatInterval must be a finite number of milliseconds >= 1 (got ${shown})`
      )
    );
  });

  test('accepts 1 ms, the smallest positive interval', async () => {
    const worker = build(1);
    try {
      expect(worker.opts.heartbeatInterval).toBe(1);
    } finally {
      await worker.close(true);
    }
  });

  test('rejects a non-numeric string with a TypeError; a numeric one is a number', async () => {
    expect(() => build('often')).toThrow(TypeError);
    const worker = build('10000');
    try {
      expect(worker.opts.heartbeatInterval).toBe(10_000);
    } finally {
      await worker.close(true);
    }
  });

  test('0, -0, a negative value and NaN disable both heartbeat timers; undefined keeps 10 s', async () => {
    for (const value of [-0, -1, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const worker = build(value);
      expect(worker.opts.heartbeatInterval).toBe(0);
      await worker.close(true);
    }
    const disabled = build(0);
    const defaulted = build(undefined);
    try {
      disabled.run();
      const timers = disabled as unknown as {
        heartbeatTimer: unknown;
        workerHeartbeatTimer: unknown;
      };
      expect(timers.heartbeatTimer).toBeNull();
      expect(timers.workerHeartbeatTimer).toBeNull();
      expect(defaulted.opts.heartbeatInterval).toBe(10_000);
    } finally {
      await disabled.close(true);
      await defaulted.close(true);
    }
  });
});
