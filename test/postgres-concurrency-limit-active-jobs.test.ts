/**
 * PostgreSQL parity for model seed 418721315 (path 108): a queue concurrency
 * limit set while jobs of the queue are already active counts them.
 *
 * The PostgreSQL engine derives capacity from the leased `active` rows of the
 * queue inside the claim transaction, so a limit set (or cleared and set again)
 * after jobs became active counts them, whichever broker claimed them, and a
 * completion can never free more than the slot its own row occupied.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import { cleanupPostgresNamespace } from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespaces: string[] = [];

function namespace(label: string): string {
  const value = `test-limit-active-${label}-${Date.now()}-${crypto.randomUUID()}`;
  namespaces.push(value);
  return value;
}

function manager(value: string, brokerId: string): PostgresQueueManager {
  return new PostgresQueueManager({
    postgres: { url: postgresUrl!, namespace: value, brokerId, pollIntervalMs: 25 },
  });
}

async function withManagers(
  label: string,
  brokers: string[],
  run: (...managers: PostgresQueueManager[]) => Promise<void>
): Promise<void> {
  const value = namespace(label);
  const managers = brokers.map((brokerId) => manager(value, brokerId));
  try {
    await Promise.all(managers.map((m) => m.waitUntilReady()));
    await run(...managers);
  } finally {
    await Promise.allSettled(managers.map((m) => m.shutdownPostgres()));
  }
}

afterAll(async () => {
  if (!postgresUrl) return;
  for (const value of namespaces) await cleanupPostgresNamespace(postgresUrl, value);
});

describe('PostgreSQL concurrency limit counts jobs already active', () => {
  test.skipIf(!postgresUrl)('setConcurrency(2) with one active job admits only one more', () =>
    withManagers('admits-one', ['a'], async (m) => {
      const queue = 'limit-after-active';
      await m.push(queue, { data: { n: 1 } });
      expect(await m.pull(queue)).not.toBeNull();

      await m.setConcurrencyDurable(queue, 2);
      await m.push(queue, { data: { n: 2 } });
      await m.push(queue, { data: { n: 3 } });

      expect(await m.pullBatch(queue, 2)).toHaveLength(1);
      expect(m.getQueueJobCounts(queue).active).toBe(2);
    })
  );

  test.skipIf(!postgresUrl)('a job active before the limit frees no phantom slot', () =>
    withManagers('phantom', ['a'], async (m) => {
      const queue = 'limit-phantom-release';
      await m.push(queue, { data: { n: 1 } });
      const early = await m.pull(queue);
      expect(early).not.toBeNull();

      await m.setConcurrencyDurable(queue, 1);
      await m.push(queue, { data: { n: 2 } });
      expect(await m.pull(queue)).toBeNull();

      await m.ack(early!.id, 'done');
      expect(await m.pull(queue)).not.toBeNull();

      await m.push(queue, { data: { n: 3 } });
      expect(await m.pull(queue)).toBeNull();
      expect(m.getQueueJobCounts(queue).active).toBe(1);
    })
  );

  test.skipIf(!postgresUrl)('clear then set keeps counting the running jobs', () =>
    withManagers('clear-set', ['a'], async (m) => {
      const queue = 'limit-clear-set';
      await m.setConcurrencyDurable(queue, 1);
      await m.push(queue, { data: { n: 1 } });
      expect(await m.pull(queue)).not.toBeNull();

      await m.setConcurrencyDurable(queue, null);
      await m.setConcurrencyDurable(queue, 1);
      await m.push(queue, { data: { n: 2 } });

      expect(await m.pull(queue)).toBeNull();
      expect(m.getQueueJobCounts(queue).active).toBe(1);
    })
  );

  test.skipIf(!postgresUrl)('a limit set by another broker counts jobs claimed elsewhere', () =>
    withManagers('cross-broker', ['a', 'b'], async (a, b) => {
      const queue = 'limit-cross-broker';
      for (let n = 0; n < 4; n++) await a.push(queue, { data: { n } });
      expect(await a.pullBatch(queue, 2)).toHaveLength(2);

      await b.setConcurrencyDurable(queue, 3);

      expect(await b.pullBatch(queue, 2)).toHaveLength(1);
      expect(await a.pull(queue)).toBeNull();
    })
  );
});
