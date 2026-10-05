/**
 * Repro: PostgreSQL runtime timers spun once a period passed the native timer limit.
 *
 * Bun arms a `setInterval`/`setTimeout` above 2^31 - 1 ms after about 1 ms. The
 * broker heartbeat (lease / 3), expired-lease recovery (lease / 2), cron polling and
 * durable event polling (pollIntervalMs) therefore ran hundreds of times per second,
 * and a long event wait returned at once. No database is needed: the pool is lazy and
 * every maintenance call is intercepted before it reaches SQL.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import type { PostgresContext } from '../src/infrastructure/persistence/postgres/context';
import { PostgresEventStream } from '../src/infrastructure/persistence/postgres/events';
import { PostgresQueueStoreRuntime } from '../src/infrastructure/persistence/postgres/runtime';
import { resolvePostgresRuntimeConfig } from '../src/infrastructure/persistence/postgres/runtimeConfig';

const unusedUrl = 'postgres://bunqueue:unused@127.0.0.1:1/never';
const BEYOND_TIMER_LIMIT_MS = 2 ** 31;
const OBSERVATION_MS = 100;
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface MaintainableRuntime {
  startMaintenance(): void;
  stopMaintenance(): void;
  runMaintenance(operation: () => Promise<unknown>, subsystem?: string): Promise<void>;
}

/** A context whose SQL answers the event stream's startup queries without a database. */
function fakeEventContext(pollIntervalMs: number): PostgresContext {
  const query = async (strings: TemplateStringsArray) =>
    strings.join('').includes('latest_event_id')
      ? [{ commit_seq: null, latest_event_id: null }]
      : [];
  const sql = Object.assign(query, {
    listen: async () => ({ unlisten: async () => undefined }),
  });
  return {
    sql: sql as unknown as SQL,
    config: resolvePostgresRuntimeConfig({
      url: unusedUrl,
      namespace: 'timer-repro',
      brokerId: 'timer-repro',
      pollIntervalMs,
    }),
  };
}

function settledFlag(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  return () => settled;
}

describe('PostgreSQL runtime timers beyond the native limit', () => {
  test('heartbeat, lease recovery and cron polling do not spin', async () => {
    const runtime = new PostgresQueueStoreRuntime({
      url: unusedUrl,
      namespace: 'timer-repro',
      brokerId: 'timer-repro',
      // heartbeat = lease / 3 and recovery = lease / 2 both exceed 2^31 - 1 ms.
      leaseDurationMs: 6_500_000_000,
      pollIntervalMs: BEYOND_TIMER_LIMIT_MS,
    });
    const internals = runtime as unknown as MaintainableRuntime;
    cleanups.push(() => runtime.context.sql.close({ timeout: 1 }));
    const ticks: Record<string, number> = {};
    internals.runMaintenance = async (_operation, subsystem = 'maintenance') => {
      ticks[subsystem] = (ticks[subsystem] ?? 0) + 1;
    };

    internals.startMaintenance();
    cleanups.push(async () => internals.stopMaintenance());
    await Bun.sleep(OBSERVATION_MS);

    expect(ticks).toEqual({});
  });

  test('durable event polling does not spin', async () => {
    const stream = new PostgresEventStream(fakeEventContext(BEYOND_TIMER_LIMIT_MS));
    cleanups.push(() => stream.close());
    await stream.start();
    let drains = 0;
    (stream as unknown as { drain(): Promise<void> }).drain = async () => {
      drains++;
    };

    await Bun.sleep(OBSERVATION_MS);

    expect(drains).toBe(0);
  });

  test('a wait longer than the native limit stays pending until woken', async () => {
    const stream = new PostgresEventStream(fakeEventContext(250));
    const settled = settledFlag(stream.wait('long-wait', BEYOND_TIMER_LIMIT_MS));

    await Bun.sleep(OBSERVATION_MS);
    expect(settled()).toBe(false);

    await stream.close();
    await Bun.sleep(0);
    expect(settled()).toBe(true);
  });

  test('a NaN wait returns at once instead of arming a 1 ms timer', async () => {
    const stream = new PostgresEventStream(fakeEventContext(250));
    cleanups.push(() => stream.close());

    const first = await Promise.race([
      stream.wait('nan-wait', Number.NaN).then(() => 'resolved'),
      Promise.resolve().then(() => 'pending'),
    ]);

    expect(first).toBe('resolved');
  });
});
