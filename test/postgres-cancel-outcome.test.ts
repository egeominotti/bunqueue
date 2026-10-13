/**
 * Issue #155 B on PostgreSQL: the Cancel reply for a protected producer, and WaitJob
 * after a completed job was removed.
 *
 * `cancelPostgresJob` refuses a waiting job that a live job depends on (a protected
 * producer). The state read after the refusal is `waiting`, a state Cancel removes, so
 * `cancelWithOutcome` retries once, sees the same state and stops: the reply names it
 * and `removeAsync` rejects with it. A completed job removed by Cancel keeps its
 * completion tombstone without the result, so WaitJob on its ID answers
 * `completed: true` with no result.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import { Queue } from '../src/client';
import { TcpClient } from '../src/client/tcp/client';
import type { JobId } from '../src/domain/types/job';
import { handleCommand } from '../src/infrastructure/server/handler';
import { createTcpServer } from '../src/infrastructure/server/tcp';
import type { HandlerContext } from '../src/infrastructure/server/types';
import { cleanupPostgresNamespace } from './support/postgres-event-race';

const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespaces: string[] = [];
const REFUSED_WAITING = 'Job cannot be cancelled (current state: waiting)';

function broker(label: string): PostgresQueueManager {
  const namespace = `test-cancel-outcome-${label}-${Date.now()}-${crypto.randomUUID()}`;
  namespaces.push(namespace);
  return new PostgresQueueManager({
    postgres: { url: postgresUrl!, namespace, brokerId: `cancel-outcome-${label}` },
  });
}

function context(manager: PostgresQueueManager): HandlerContext {
  return {
    queueManager: manager,
    authTokens: new Set<string>(),
    authenticated: false,
    clientId: 'cancel-outcome',
  };
}

/** Count the engine Cancel attempts made through `manager.cancel`. */
function countCancels(manager: PostgresQueueManager): { attempts: number } {
  const counter = { attempts: 0 };
  const cancel = manager.cancel.bind(manager);
  manager.cancel = async (id: JobId) => {
    counter.attempts++;
    return await cancel(id);
  };
  return counter;
}

afterAll(async () => {
  if (!postgresUrl) return;
  for (const namespace of namespaces) await cleanupPostgresNamespace(postgresUrl, namespace);
});

describe('PostgreSQL Cancel outcome', () => {
  test.skipIf(!postgresUrl)(
    'a protected producer is refused naming its state, after two attempts',
    async () => {
      const manager = broker('protected');
      await manager.waitUntilReady();
      const server = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
      const queue = new Queue('cancel-protected', {
        embedded: false,
        connection: { host: '127.0.0.1', port: server.server.port, poolSize: 1 },
        autoBatch: { enabled: false },
      });
      try {
        const producer = await manager.push('cancel-protected', { data: { secret: 'x' } });
        const consumer = await manager.push('cancel-protected', {
          data: {},
          dependsOn: [producer.id],
        });
        expect(await manager.getJobState(producer.id)).toBe('waiting');
        expect(await manager.getJobState(consumer.id)).toBe('waiting-children');
        const counter = countCancels(manager);

        expect(
          await handleCommand({ cmd: 'Cancel', id: String(producer.id) }, context(manager))
        ).toMatchObject({ ok: false, error: REFUSED_WAITING });
        expect(counter.attempts).toBe(2);
        await expect(queue.removeAsync(String(producer.id))).rejects.toThrow(REFUSED_WAITING);
        expect(counter.attempts).toBe(4);
        expect(await manager.getJobState(producer.id)).toBe('waiting');

        // Once the consumer is gone the producer is no longer protected.
        await queue.removeAsync(String(consumer.id));
        await queue.removeAsync(String(producer.id));
        expect(await manager.getJobState(producer.id)).toBe('unknown');
      } finally {
        await queue.close();
        server.stop();
        await manager.shutdownPostgres();
      }
    }
  );

  test.skipIf(!postgresUrl)(
    'WaitJob on a completed job removed by Cancel answers completed without a result',
    async () => {
      const manager = broker('wait');
      await manager.waitUntilReady();
      const server = createTcpServer(manager, { hostname: '127.0.0.1', port: 0 });
      const client = new TcpClient({
        host: '127.0.0.1',
        port: server.server.port,
        autoReconnect: false,
        pingInterval: 0,
        commandTimeout: 5_000,
      });
      try {
        await client.connect();
        const job = await manager.push('cancel-wait', { data: { secret: 'x' } });
        const claimed = await manager.pullWithLock('cancel-wait', 'wait-worker');
        expect(claimed.job?.id).toBe(job.id);
        await manager.ack(job.id, { answer: 4 }, claimed.token!);
        expect(await manager.cancel(job.id)).toBe(true);
        const id = String(job.id);

        const handled = await handleCommand({ cmd: 'WaitJob', id, timeout: 100 }, context(manager));
        expect(handled).toMatchObject({ ok: true, completed: true });
        expect((handled as { result?: unknown }).result).toBeUndefined();

        const wire = await client.send({ cmd: 'WaitJob', id, timeout: 100 });
        expect(wire).toMatchObject({ ok: true, completed: true });
        expect(wire.result ?? undefined).toBeUndefined();
      } finally {
        client.close();
        server.stop();
        await manager.shutdownPostgres();
      }
    }
  );
});
