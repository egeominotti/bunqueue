/**
 * Repro: a Bunqueue constructor that throws after creating its Queue (or its Worker)
 * left them behind. The Queue kept its reference on the shared TCP pool, so the pool
 * could never close; a Worker created before a later failure kept polling and
 * processing jobs with no object left to close it. Options the Bunqueue forwards are
 * validated by the Worker (an invalid `rateLimit`, for instance), so a rejected
 * construction must release everything it created before rethrowing.
 */
import { afterEach, expect, test } from 'bun:test';
import { Bunqueue, Queue, shutdownManager } from '../src/client';

afterEach(() => {
  shutdownManager();
});

const processor = async () => null;

test('a Worker that rejects a forwarded option releases the Queue connection', () => {
  // Nothing listens here and nothing connects: TCP clients connect on first command.
  const connection = { host: '127.0.0.1', port: 1 };
  const holder = new Queue(`cleanup-holder-${process.pid}`, { embedded: false, connection });
  const pool = (holder as unknown as { tcpPool: { isClosed(): boolean } }).tcpPool;
  let error: unknown = null;
  try {
    const app = new Bunqueue(`cleanup-rejected-${process.pid}`, {
      embedded: false,
      connection,
      processor,
      rateLimit: { max: 0, duration: 1_000 },
    });
    void app.close(true);
  } catch (thrown) {
    error = thrown;
  }
  expect(error).toBeInstanceOf(RangeError);

  // The shared pool closes when its last reference is released: the holder's.
  holder.close();
  expect(pool.isClosed()).toBe(true);
});

test('a failure after the Worker started stops it before rethrowing', async () => {
  const name = `cleanup-running-${process.pid}`;
  let processed = 0;
  const failure = new Error('dlq configuration failed');
  const dlq = {
    get autoRetry(): boolean {
      throw failure;
    },
  };
  let error: unknown = null;
  try {
    const app = new Bunqueue(name, {
      embedded: true,
      heartbeatInterval: 0,
      processor: async () => {
        processed++;
        return null;
      },
      dlq,
    });
    void app.close(true);
  } catch (thrown) {
    error = thrown;
  }
  expect(error).toBe(failure);

  const queue = new Queue(name, { embedded: true });
  try {
    const job = await queue.add('job', {});
    await Bun.sleep(150);
    expect(processed).toBe(0);
    expect(await queue.getJobState(job.id)).toBe('waiting');
  } finally {
    queue.close();
  }
});
