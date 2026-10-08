/**
 * A PostgreSQL pull cancelled while it awaits (server shutdown drain, or its client
 * disconnecting) must claim nothing. `claimUntil` awaits readiness, the deferred
 * write flush and operation admission before the claim; checking the signal only on
 * entry let a drain that began during those awaits still claim a job.
 *
 * Runs without PostgreSQL: the manager is built from its prototype with stubbed
 * storage, so only the delivery bridge's own control flow is exercised.
 */

import { describe, expect, test } from 'bun:test';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';

interface Stub {
  manager: PostgresQueueManager;
  claims: () => number;
}

/** A manager whose `abortAt` step aborts `controller`, then counts claim attempts. */
function stubbedManager(
  controller: AbortController,
  abortAt: 'ready' | 'flush' | 'admission' | 'wait' | 'never'
): Stub {
  let claims = 0;
  const manager = Object.create(PostgresQueueManager.prototype) as PostgresQueueManager;
  const abortIf = (step: typeof abortAt) => {
    if (abortAt === step) controller.abort();
  };
  Object.assign(manager, {
    postgresReady: Promise.resolve().then(() => abortIf('ready')),
    flushPostgresWrites: async () => abortIf('flush'),
    runPostgresOperation: async <T>(operation: () => Promise<T>) => {
      abortIf('admission');
      return await operation();
    },
    applyPostgresClaim: () => undefined,
    postgresStore: {
      config: { brokerId: 'broker-1', pollIntervalMs: 5 },
      claim: async () => {
        claims++;
        return [];
      },
      waitForWork: async () => abortIf('wait'),
    },
  });
  return { manager, claims: () => claims };
}

describe('PostgreSQL claim loop under a cancelled pull', () => {
  for (const step of ['ready', 'flush', 'admission'] as const) {
    test(`a drain that starts during ${step} claims nothing`, async () => {
      const controller = new AbortController();
      const { manager, claims } = stubbedManager(controller, step);

      expect(await manager.pull('q', 1_000, controller.signal)).toBeNull();
      expect(
        await manager.pullBatchWithLock('q', 5, 'w', 1_000, 30_000, controller.signal)
      ).toEqual({ jobs: [], tokens: [] });
      expect(claims()).toBe(0);
    });
  }

  test('a drain that starts while waiting for work ends the loop after one claim', async () => {
    const controller = new AbortController();
    const { manager, claims } = stubbedManager(controller, 'wait');

    expect(await manager.pull('q', 1_000, controller.signal)).toBeNull();
    expect(claims()).toBe(1);
  });

  test('a pull that is not cancelled still claims', async () => {
    const controller = new AbortController();
    const { manager, claims } = stubbedManager(controller, 'never');

    expect(await manager.pull('q', 0, controller.signal)).toBeNull();
    expect(claims()).toBe(1);
  });
});
