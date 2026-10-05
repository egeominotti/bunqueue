/**
 * Repro: PostgreSQL manager waits that ignored the timer limit or the shutdown.
 *
 * - A NaN pull timeout slipped through `timeoutMs <= 0` and every `remaining <= 0`
 *   guard, so `claimUntil` claimed in a loop until the caller aborted. The pull now
 *   reads its timeout like the base engine (`pullTimeoutArgument`): NaN or a negative
 *   value means no wait (one claim), and Infinity waits for a job as 2.9.10 did,
 *   claiming once per poll interval until the caller aborts.
 * - With pollIntervalMs above 2^31 - 1 ms a long pull's wait timer fired after about
 *   1 ms, so an empty queue was claimed hundreds of times per second. The event
 *   stream's own wait beyond the native limit is covered by
 *   repro-postgres-timers-runtime.test.ts.
 * - A failed queue refresh slept a full poll interval with an uncancellable
 *   `Bun.sleep`, so shutdown waited for that whole interval.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import {
  cleanupPostgresNamespace,
  eventually,
  postgresManagerStore,
} from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespaces: string[] = [];
const managers: PostgresQueueManager[] = [];

async function openManager(label: string, pollIntervalMs: number): Promise<PostgresQueueManager> {
  const namespace = `test-timers-manager-${label}-${Date.now()}-${crypto.randomUUID()}`;
  namespaces.push(namespace);
  const manager = new PostgresQueueManager({
    postgres: { url: postgresUrl!, namespace, brokerId: label, pollIntervalMs },
  });
  managers.push(manager);
  await manager.waitUntilReady();
  return manager;
}

/** Count every claim transaction the manager starts. */
function countClaims(manager: PostgresQueueManager): () => number {
  const store = postgresManagerStore(manager);
  const claim = store.claim.bind(store);
  let claims = 0;
  store.claim = (...args: Parameters<typeof claim>) => {
    claims++;
    return claim(...args);
  };
  return () => claims;
}

function abortAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

afterAll(async () => {
  await Promise.allSettled(managers.map((manager) => manager.shutdownPostgres()));
  if (!postgresUrl) return;
  for (const namespace of namespaces) await cleanupPostgresNamespace(postgresUrl, namespace);
});

describe('PostgreSQL manager waits', () => {
  test.skipIf(!postgresUrl)(
    'a NaN pull timeout claims once and an infinite one polls until aborted',
    async () => {
      const manager = await openManager('nan-pull', 25);
      const claims = countClaims(manager);

      // NaN means no wait: a single claim, never a claim loop.
      expect(await manager.pull('empty-nan', Number.NaN, abortAfter(500))).toBeNull();
      expect(claims()).toBe(1);

      // Infinity waits for a job (2.9.10), claiming at most once per 25 ms poll.
      const started = Date.now();
      expect(await manager.pull('empty-nan', Number.POSITIVE_INFINITY, abortAfter(500))).toBeNull();
      expect(Date.now() - started).toBeGreaterThanOrEqual(450);
      const polls = claims() - 1;
      expect(polls).toBeGreaterThanOrEqual(2);
      expect(polls).toBeLessThan(60);
    }
  );

  test.skipIf(!postgresUrl)(
    'a long pull with a poll interval beyond the timer limit waits instead of re-claiming',
    async () => {
      const manager = await openManager('long-poll', 2 ** 31);
      const claims = countClaims(manager);

      const job = await manager.pull('empty-long', 60_000, abortAfter(300));

      expect(job).toBeNull();
      expect(claims()).toBe(1);
    }
  );

  test.skipIf(!postgresUrl)('a long pull still wakes for a new job', async () => {
    const manager = await openManager('long-wake', 2 ** 31);
    const pulled = manager.pull('wake', 60_000, abortAfter(5_000));
    await Bun.sleep(50);

    const pushed = await manager.push('wake', { data: { wake: true } });

    expect((await pulled)?.id).toBe(pushed.id);
  });

  test.skipIf(!postgresUrl)(
    'shutdown cancels a pending queue-refresh retry',
    async () => {
      const manager = await openManager('refresh-retry', 60_000);
      const store = postgresManagerStore(manager);
      let failures = 0;
      store.loadQueueReadModel = async () => {
        failures++;
        throw new Error('injected queue refresh failure');
      };
      (manager as unknown as { scheduleQueueRefresh(queue: string): void }).scheduleQueueRefresh(
        'refresh-retry'
      );
      expect(await eventually(() => failures === 1)).toBe(true);

      const started = performance.now();
      await manager.shutdownPostgres();

      expect(performance.now() - started).toBeLessThan(5_000);
      expect(failures).toBe(1);
    },
    20_000
  );
});
