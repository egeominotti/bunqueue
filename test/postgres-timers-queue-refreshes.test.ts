/**
 * PostgresQueueRefreshes: full-queue refresh retries honour any poll interval and end
 * at once on stop. No database is needed: the refresh is a stub.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { PostgresQueueRefreshes } from '../src/application/postgres-queue-manager/queueRefreshes';
import { eventually } from './support/postgres-event-race';

const BEYOND_TIMER_LIMIT_MS = 2 ** 31;
const ready = () => Promise.resolve();
const active: PostgresQueueRefreshes[] = [];

afterEach(async () => {
  for (const refreshes of active.splice(0)) {
    refreshes.stop();
    await refreshes.settled();
  }
});

function refreshes(
  refresh: (queue: string) => Promise<unknown>,
  retryDelayMs: number,
  reports: unknown[] = []
): PostgresQueueRefreshes {
  const value = new PostgresQueueRefreshes(
    ready,
    refresh,
    (_queue, error) => reports.push(error),
    retryDelayMs
  );
  active.push(value);
  return value;
}

describe('PostgreSQL queue refresh retries', () => {
  test('a failure waits a retry delay beyond the timer limit, and stop ends the wait', async () => {
    let attempts = 0;
    const subject = refreshes(async () => {
      attempts++;
      throw new Error('database unavailable');
    }, BEYOND_TIMER_LIMIT_MS);

    subject.schedule('orders');
    await Bun.sleep(100);
    expect(attempts).toBe(1);

    const started = performance.now();
    subject.stop();
    await subject.settled();
    expect(performance.now() - started).toBeLessThan(50);
    expect(attempts).toBe(1);
  });

  test('a queue scheduled again while it loads waits one poll interval, then reloads', async () => {
    const reports: unknown[] = [];
    const starts: number[] = [];
    // As when a queue invalidation arrives while the manager loads that queue.
    const subject: PostgresQueueRefreshes = refreshes(
      async (queue) => {
        starts.push(performance.now());
        if (starts.length === 1) subject.schedule(queue);
      },
      20,
      reports
    );

    subject.schedule('orders');

    expect(await eventually(() => starts.length === 2)).toBe(true);
    await subject.settled();
    expect(reports).toEqual([null, null]);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(15);
  });

  test('a failure retries after the poll interval and reports recovery', async () => {
    const reports: unknown[] = [];
    let attempts = 0;
    const subject = refreshes(
      async () => {
        attempts++;
        if (attempts === 1) throw new Error('transient');
        return true;
      },
      20,
      reports
    );

    subject.schedule('orders');

    expect(await eventually(() => attempts === 2)).toBe(true);
    await subject.settled();
    expect(reports[0]).toBeInstanceOf(Error);
    expect(reports.at(-1)).toBeNull();
  });

  test('coalesces requests into the running loop and ignores them after stop', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loads: string[] = [];
    const subject = refreshes(async (queue) => {
      loads.push(queue);
      if (loads.length === 1) await gate;
      return true;
    }, 25);

    subject.schedule('orders');
    await Bun.sleep(5);
    subject.schedule('orders');
    subject.schedule('orders');
    release();
    expect(await eventually(() => loads.length === 2)).toBe(true);
    await subject.settled();
    subject.stop();
    subject.schedule('orders');
    await subject.settled();

    expect(loads).toEqual(['orders', 'orders']);
  });

  test('rejects a retry delay that is not a duration', () => {
    for (const retryDelayMs of [Number.NaN, -1, Infinity]) {
      expect(
        () =>
          new PostgresQueueRefreshes(
            ready,
            async () => true,
            () => undefined,
            retryDelayMs
          )
      ).toThrow(RangeError);
    }
  });
});
