/**
 * Regression: Worker.close() emitted its own ClientClosedError as a Worker `error`.
 *
 * The worker-registration heartbeat (`Heartbeat`, runtime/execution.ts) and the
 * job-lease heartbeat (`JobHeartbeat`, workerHeartbeat.ts) are fire-and-forget: a
 * rejected command is re-emitted as `error` with context `worker-heartbeat` or
 * `heartbeat`. close() clears both timers, but a heartbeat already in flight is
 * rejected with ClientClosedError when close() ends the Worker's own pool, and was
 * emitted after the caller asked for the shutdown. A Worker without an `error`
 * listener turned it into an unhandled error (seen once in a PostgreSQL stress run
 * of test/postgres-public-api-extreme.test.ts).
 *
 * A fake broker holds the heartbeat unanswered, so it is in flight when close()
 * ends the pool. A heartbeat ClientClosedError is dropped only once close() has
 * started: one that arrives while the Worker runs (its pool closed from outside)
 * and any other heartbeat failure still surface.
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

function startBroker(hold: string[]): FakeWorkerBroker {
  const broker = new FakeWorkerBroker({ hold });
  brokers.push(broker);
  return broker;
}

function startWorker(
  broker: FakeWorkerBroker,
  processor: () => Promise<unknown>,
  commandTimeout = 30_000
): Worker {
  const worker = new Worker('close-heartbeat', processor, {
    embedded: false,
    heartbeatInterval: 25,
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

describe('Worker.close() with a heartbeat in flight', () => {
  test("a held worker Heartbeat is not emitted as 'error' after close()", async () => {
    const broker = startBroker(['Heartbeat']);
    const worker = startWorker(broker, async () => 'done');
    const errors: ContextError[] = [];
    worker.on('error', (error: ContextError) => errors.push(error));

    await waitFor(() => broker.received('Heartbeat').length > 0);
    await worker.close();
    await Bun.sleep(20);

    expect(errors.map((error) => `${error.context}: ${error.name}`)).toEqual([]);
  });

  test("a held JobHeartbeat is not emitted as 'error' after close()", async () => {
    const broker = startBroker(['JobHeartbeat', 'JobHeartbeatB']);
    broker.offerJob('job-1');
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const worker = startWorker(broker, async () => {
      started.resolve(undefined);
      await release.promise;
      return 'done';
    });
    const errors: ContextError[] = [];
    worker.on('error', (error: ContextError) => errors.push(error));

    await started.promise;
    await waitFor(() => broker.received('JobHeartbeat').length > 0);
    const closing = worker.close();
    release.resolve(undefined);
    await closing;
    await Bun.sleep(20);

    expect(broker.received('ACKB').length).toBe(1);
    expect(errors.map((error) => `${error.context}: ${error.name}`)).toEqual([]);
  });

  test("without an 'error' listener close() leaves no unhandled rejection", async () => {
    const broker = startBroker(['Heartbeat']);
    const worker = startWorker(broker, async () => 'done');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await waitFor(() => broker.received('Heartbeat').length > 0);
      await worker.close();
      await Bun.sleep(20);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled.map((reason) => String(reason))).toEqual([]);
  });

  test('a ClientClosedError while the Worker is running (not closing) still emits error', async () => {
    const broker = startBroker(['Heartbeat']);
    const worker = startWorker(broker, async () => 'done');
    const errors: ContextError[] = [];
    worker.on('error', (error: ContextError) => errors.push(error));

    await waitFor(() => broker.received('Heartbeat').length > 0);
    // The pool is closed from outside the Worker: close() has not started.
    (worker as unknown as { tcpPool: { close(): void } }).tcpPool.close();
    await waitFor(() => errors.some((error) => error.context === 'worker-heartbeat'));

    const failure = errors.find((error) => error.context === 'worker-heartbeat');
    expect(failure?.name).toBe('ClientClosedError');
  });

  test('a heartbeat that fails while the Worker runs still emits error', async () => {
    const broker = startBroker(['Heartbeat']);
    const worker = startWorker(broker, async () => 'done', 100);
    const errors: ContextError[] = [];
    worker.on('error', (error: ContextError) => errors.push(error));

    await waitFor(() => errors.some((error) => error.context === 'worker-heartbeat'));

    const failure = errors.find((error) => error.context === 'worker-heartbeat');
    expect(failure?.message).toBe('Command timeout');
  });
});
