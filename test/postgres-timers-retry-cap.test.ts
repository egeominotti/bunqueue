/**
 * Repro: with a long pollIntervalMs the manager retried a failed queue refresh or
 * projection load only after the full interval (60 s here). Both retries are now
 * capped at 1 s, like the queue refresh backoff, whatever the poll interval.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { jobId } from '../src/domain/types/job';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import {
  cleanupPostgresNamespace,
  eventually,
  postgresManagerStore,
} from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespaces: string[] = [];
const managers: PostgresQueueManager[] = [];

async function openManager(label: string): Promise<PostgresQueueManager> {
  const namespace = `test-timers-retry-cap-${label}-${Date.now()}-${crypto.randomUUID()}`;
  namespaces.push(namespace);
  const manager = new PostgresQueueManager({
    postgres: { url: postgresUrl!, namespace, brokerId: label, pollIntervalMs: 60_000 },
  });
  managers.push(manager);
  await manager.waitUntilReady();
  return manager;
}

afterAll(async () => {
  await Promise.allSettled(managers.map((manager) => manager.shutdownPostgres()));
  if (!postgresUrl) return;
  for (const namespace of namespaces) await cleanupPostgresNamespace(postgresUrl, namespace);
});

describe('PostgreSQL manager retries with a long poll interval', () => {
  test.skipIf(!postgresUrl)('a failed queue refresh is retried within about 1 s', async () => {
    const manager = await openManager('queue-refresh');
    const store = postgresManagerStore(manager);
    const load = store.loadQueueReadModel;
    let loads = 0;
    store.loadQueueReadModel = async (queue) => {
      loads++;
      if (loads === 1) throw new Error('injected queue refresh failure');
      return await load(queue);
    };

    (manager as unknown as { scheduleQueueRefresh(queue: string): void }).scheduleQueueRefresh(
      'retry-cap'
    );

    expect(await eventually(() => loads >= 2, 2_500)).toBe(true);
    expect(await eventually(() => manager.getStorageStatus().error === null)).toBe(true);
  });

  test.skipIf(!postgresUrl)('a failed projection load is retried within about 1 s', async () => {
    const manager = await openManager('projection');
    const store = postgresManagerStore(manager);
    const load = store.loadJobProjections.bind(store);
    let loads = 0;
    store.loadJobProjections = async (requests) => {
      loads++;
      if (loads === 1) throw new Error('injected projection failure');
      return await load(requests);
    };
    const refreshes = Reflect.get(manager, 'projectionRefreshes') as {
      request(id: ReturnType<typeof jobId>, queue: string): void;
    };

    refreshes.request(jobId('retry-cap-projection'), 'retry-cap');

    expect(await eventually(() => loads >= 2, 2_500)).toBe(true);
    expect(await eventually(() => manager.getStorageStatus().error === null)).toBe(true);
  });
});
