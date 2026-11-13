/**
 * Regression: Worker.close() emitted its own ClientClosedError from RegisterWorker.
 *
 * registerWithServer() (runtime/execution.ts) sends RegisterWorker fire-and-forget
 * and re-emits a rejection as `error` with context `worker-register`. A
 * RegisterWorker still in flight when close() ends the Worker's own pool (a close
 * right after construction, or right after a reconnect) was rejected with
 * ClientClosedError and emitted after the caller asked for the shutdown; a Worker
 * without an `error` listener turned it into an unhandled error.
 *
 * A fake broker holds RegisterWorker unanswered, so it is in flight when close()
 * ends the pool. A RegisterWorker ClientClosedError is dropped only once close() has
 * started: one that arrives while the Worker runs (its pool closed from outside) and
 * any other register failure still surface.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Worker } from '../src/client/worker';
import { FakeWorkerBroker } from './support/fake-worker-broker';

const brokers: FakeWorkerBroker[] = [];
const workers: Worker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close(true).catch(() => {})));
  for (const broker of brokers.splice(0)) broker.stop();
});

function startBroker(): FakeWorkerBroker {
  const broker = new FakeWorkerBroker({ hold: ['RegisterWorker'] });
  brokers.push(broker);
  return broker;
}

function startWorker(broker: FakeWorkerBroker, commandTimeout = 30_000): Worker {
  const worker = new Worker('close-register', async () => 'done', {
    embedded: false,
    connection: { host: '127.0.0.1', port: broker.port, pingInterval: 0, commandTimeout },
  });
  workers.push(worker);
  return worker;
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met before the deadline');
    await Bun.sleep(5);
  }
}

type ContextError = Error & { context?: string };

describe('Worker.close() with a RegisterWorker in flight', () => {
  test("a held RegisterWorker is not emitted as 'error' after close()", async () => {
    const broker = startBroker();
    const worker = startWorker(broker);
    const errors: ContextError[] = [];
    worker.on('error', (error: ContextError) => errors.push(error));

    await waitFor(() => broker.received('RegisterWorker').length > 0);
    await worker.close();
    await Bun.sleep(20);

    expect(errors.map((error) => `${error.context}: ${error.name}`)).toEqual([]);
  });

  test("without an 'error' listener close() leaves no unhandled rejection", async () => {
    const broker = startBroker();
    const worker = startWorker(broker);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await waitFor(() => broker.received('RegisterWorker').length > 0);
      await worker.close();
      await Bun.sleep(20);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled.map((reason) => String(reason))).toEqual([]);
  });

  test('a ClientClosedError while the Worker is running (not closing) still emits error', async () => {
    const broker = startBroker();
    const worker = startWorker(broker);
    const errors: ContextError[] = [];
    worker.on('error', (error: ContextError) => errors.push(error));

    await waitFor(() => broker.received('RegisterWorker').length > 0);
    // The pool is closed from outside the Worker: close() has not started.
    (worker as unknown as { tcpPool: { close(): void } }).tcpPool.close();
    await waitFor(() => errors.some((error) => error.context === 'worker-register'));

    const failure = errors.find((error) => error.context === 'worker-register');
    expect(failure?.name).toBe('ClientClosedError');
  });

  test('a RegisterWorker that fails while the Worker runs still emits error', async () => {
    const broker = startBroker();
    const worker = startWorker(broker, 100);
    const errors: ContextError[] = [];
    worker.on('error', (error: ContextError) => errors.push(error));

    await waitFor(() => errors.some((error) => error.context === 'worker-register'));

    const failure = errors.find((error) => error.context === 'worker-register');
    expect(failure?.message).toBe('Command timeout');
  });
});
