/**
 * A client started before its broker must behave identically on the native Bun
 * transport and on the portable node:net transport shipped in bunqueue-client.
 *
 * Refused connection attempts only fail that attempt: queued commands stay
 * queued, the canonical reconnect loop retries, and the command is delivered
 * once the broker listens. The portable transport used to report every failed
 * attempt as a closed connection, which rejected every pending command with
 * "Connection lost" within milliseconds and made Workers emit repeated errors.
 */
import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import * as native from '../src/client';
import { QueueManager } from '../src/application/queueManager';
import { createTcpServer } from '../src/infrastructure/server/tcp';

// The shipped bundle drives the portable node:net transport even under Bun.
const portable = (await import('../sdk/typescript/dist/index.js')) as typeof native;

async function freePort(): Promise<number> {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  reservation.close();
  await once(reservation, 'close');
  return port;
}

function startBroker(port: number) {
  const manager = new QueueManager();
  const server = createTcpServer(manager, { port, hostname: '127.0.0.1' });
  return {
    manager,
    stop() {
      server.stop();
      manager.shutdown();
    },
  };
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await Bun.sleep(20);
  }
}

const clients = [
  ['native', native],
  ['portable', portable],
] as const;

describe('TCP client started before its broker', () => {
  test.each(clients)(
    '%s keeps a queued add() pending across refused connects and delivers it',
    async (name, client) => {
      const port = await freePort();
      const queueName = `late-broker-add-${name}`;
      const queue = new client.Queue(queueName, {
        embedded: false,
        connection: { host: '127.0.0.1', port, poolSize: 1 },
      });
      const outcome = queue.add('early', { n: 1 }).then(
        (job) => ({ job, error: undefined }),
        (error: Error) => ({ job: undefined, error })
      );
      // Several refused attempts (initial connect plus backoff retries) happen here.
      await Bun.sleep(300);
      const broker = startBroker(port);
      try {
        const { job, error } = await outcome;
        expect(error?.message).toBeUndefined();
        expect(typeof job?.id).toBe('string');
        expect(await queue.countAsync()).toBe(1);
      } finally {
        await queue.close();
        broker.stop();
      }
    },
    15000
  );

  test.each(clients)(
    '%s Worker does not report lost connections before the broker exists',
    async (name, client) => {
      const port = await freePort();
      const queueName = `late-broker-worker-${name}`;
      const connection = { host: '127.0.0.1', port, poolSize: 1 };
      const processed: string[] = [];
      const errors: string[] = [];
      const worker = new client.Worker(
        queueName,
        async (job) => {
          processed.push(job.id);
          return 'done';
        },
        { embedded: false, connection }
      );
      worker.on('error', (error: Error) => errors.push(error.message));
      const queue = new client.Queue(queueName, { embedded: false, connection });
      const added = queue.add('early', { n: 1 });
      added.catch(() => {});
      await Bun.sleep(300);
      const broker = startBroker(port);
      try {
        const job = await added;
        await waitUntil(() => processed.includes(job.id), 10000);
        expect(errors.filter((message) => message === 'Connection lost')).toEqual([]);
      } finally {
        await worker.close(true);
        await queue.close();
        broker.stop();
      }
    },
    20000
  );
});
