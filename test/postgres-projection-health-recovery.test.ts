import { afterAll, describe, expect, test } from 'bun:test';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import type { JobId } from '../src/domain/types/job';
import { readinessEndpoint } from '../src/infrastructure/server/httpEndpoints';
import {
  cleanupPostgresNamespace,
  eventually,
  pausePostgresEventStream,
  postgresManagerStore,
} from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespaces: string[] = [];

interface ProjectionOutage {
  readonly attempts: () => number;
  restore(): void;
}

interface DrainableProjectionRefreshes {
  readonly projectionRefreshes: { drain(): Promise<void> };
}

function createManager(label: string, pollIntervalMs: number): PostgresQueueManager {
  const namespace = `test-projection-health-${label}-${Date.now()}-${crypto.randomUUID()}`;
  namespaces.push(namespace);
  return new PostgresQueueManager({
    postgres: {
      url: postgresUrl!,
      namespace,
      brokerId: `projection-health-${label}`,
      poolSize: 4,
      pollIntervalMs,
      leaseDurationMs: 60_000,
    },
  });
}

/** Make every per-job projection read fail until restored, as during a short database blip. */
function failProjectionLoads(manager: PostgresQueueManager): ProjectionOutage {
  const store = postgresManagerStore(manager);
  const original = store.loadJobProjections.bind(store);
  let attempts = 0;
  store.loadJobProjections = async () => {
    attempts++;
    throw new Error('synthetic projection outage');
  };
  return {
    attempts: () => attempts,
    restore: () => {
      store.loadJobProjections = original;
    },
  };
}

/** Record a projection-refresh failure whose background retry is left pending. */
async function degradeProjection(manager: PostgresQueueManager, id: JobId): Promise<void> {
  const outage = failProjectionLoads(manager);
  try {
    expect(await manager.updateJobData(id, { degraded: true })).toBe(true);
    expect(await eventually(() => outage.attempts() >= 2)).toBe(true);
    await (manager as unknown as DrainableProjectionRefreshes).projectionRefreshes.drain();
  } finally {
    outage.restore();
  }
  expect(manager.getStorageStatus().error).toContain('Projection refresh');
  expect(readinessEndpoint(manager).status).toBe(503);
}

function expectReady(manager: PostgresQueueManager): void {
  expect(manager.getStorageStatus().error).toBeNull();
  expect(readinessEndpoint(manager).status).toBe(200);
}

afterAll(async () => {
  if (!postgresUrl) return;
  for (const namespace of namespaces) await cleanupPostgresNamespace(postgresUrl, namespace);
}, 30_000);

describe('PostgreSQL projection health recovery', () => {
  test.skipIf(!postgresUrl)(
    'a direct lease renewal clears the failed refresh whose retry it superseded',
    async () => {
      const manager = createManager('renewal', 60_000);
      try {
        await manager.waitUntilReady();
        const queue = 'projection-health-renewal';
        const { id } = await manager.push(queue, { data: { renew: true } });
        const claim = await manager.pullWithLock(queue, 'renewal-worker');
        expect(claim.job?.id).toBe(id);
        await pausePostgresEventStream(manager);
        await degradeProjection(manager, id);

        expect(await manager.heartbeatBatchDurable([id], [claim.token!])).toBe(1);

        expectReady(manager);
        expect(manager.getLockInfo(id)?.renewalCount).toBe(1);
      } finally {
        await manager.shutdownPostgres();
      }
    },
    15_000
  );

  test.skipIf(!postgresUrl)(
    'a direct batched completion clears the failed refresh whose retry it superseded',
    async () => {
      const manager = createManager('completion', 60_000);
      try {
        await manager.waitUntilReady();
        const queue = 'projection-health-completion';
        const { id } = await manager.push(queue, { data: { complete: true } });
        const claim = await manager.pullWithLock(queue, 'completion-worker');
        await pausePostgresEventStream(manager);
        await degradeProjection(manager, id);

        await manager.ackBatchWithResults([{ id, token: claim.token!, result: { done: true } }]);

        expectReady(manager);
        expect(manager.getJobIndex().get(id)?.type).toBe('completed');
      } finally {
        await manager.shutdownPostgres();
      }
    },
    15_000
  );

  test.skipIf(!postgresUrl)(
    'an authoritative queue refresh clears the failed refresh whose retry it superseded',
    async () => {
      const manager = createManager('queue-refresh', 60_000);
      try {
        await manager.waitUntilReady();
        const queue = 'projection-health-queue-refresh';
        const { id } = await manager.push(queue, { data: { waiting: true } });
        await pausePostgresEventStream(manager);
        await degradeProjection(manager, id);

        await manager.pauseDurable(queue, true);

        expectReady(manager);
        expect(manager.getJobIndex().has(id)).toBe(true);
      } finally {
        await manager.shutdownPostgres();
      }
    },
    15_000
  );

  test.skipIf(!postgresUrl)(
    'a failed job read retries its projection until storage health recovers',
    async () => {
      const manager = createManager('job-read', 25);
      try {
        await manager.waitUntilReady();
        const queue = 'projection-health-job-read';
        const { id } = await manager.push(queue, { data: { read: true } });
        await pausePostgresEventStream(manager);
        const outage = failProjectionLoads(manager);
        try {
          await expect(manager.getJob(id)).rejects.toThrow('synthetic projection outage');
        } finally {
          outage.restore();
        }
        expect(manager.getStorageStatus().error).toContain('Projection refresh');

        expect(await eventually(() => manager.getStorageStatus().error === null)).toBe(true);
        expectReady(manager);
        expect((await manager.getJob(id))?.id).toBe(id);
      } finally {
        await manager.shutdownPostgres();
      }
    },
    15_000
  );
});
