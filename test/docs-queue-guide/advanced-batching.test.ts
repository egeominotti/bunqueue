/**
 * Executable proof for the auto-batching half of /guide/queue/advanced/
 * ("Namespaces, Auto-Batching and Store-and-Forward"); store-and-forward is in
 * advanced-forward.test.ts.
 *
 * Auto-batching is observed on a real broker whose push entry points are
 * counted by a QueueManager subclass, so "one round-trip" is measured rather
 * than assumed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Queue } from '../../src/client';
import { waitUntil } from '../docs-guide-support';
import { cleanupBrokers, startBroker, track } from '../support/docs-counting-broker';

afterEach(async () => {
  await cleanupBrokers();
});

describe('queue guide · auto-batching (TCP mode)', () => {
  test('concurrent adds collapse into one bulk round-trip', async () => {
    const broker = startBroker('autobatch');
    const queue = track(
      new Queue(`autobatch-${crypto.randomUUID()}`, {
        embedded: false,
        connection: { host: '127.0.0.1', port: broker.port, poolSize: 1 },
        autoBatch: { enabled: true, maxSize: 50, maxDelayMs: 5 },
      })
    );

    const jobs = await Promise.all([
      queue.add('a', { x: 1 }),
      queue.add('b', { x: 2 }),
      queue.add('c', { x: 3 }),
    ]);

    expect(new Set(jobs.map((job) => job.id)).size).toBe(3);
    expect(broker.manager.batchPushes).toBeGreaterThanOrEqual(1);
    expect(broker.manager.batchedJobs).toBe(3);
    expect(broker.manager.singlePushes).toBe(0);
    await waitUntil(async () => (await queue.countAsync()) === 3, 'all three jobs to persist');
  }, 20_000);

  test('sequential awaits are sent immediately, one job at a time', async () => {
    const broker = startBroker('autobatch-seq');
    const queue = track(
      new Queue(`autobatch-${crypto.randomUUID()}`, {
        embedded: false,
        connection: { host: '127.0.0.1', port: broker.port, poolSize: 1 },
        autoBatch: { enabled: true },
      })
    );

    for (let i = 0; i < 3; i++) await queue.add(`job-${i}`, { i });

    // Each sequential add flushes on its own: three batches of one, never a
    // buffered group.
    expect(broker.manager.batchPushes).toBe(3);
    expect(broker.manager.batchedJobs).toBe(3);
  }, 20_000);

  test('durable jobs bypass the batcher and are pushed individually', async () => {
    const broker = startBroker('autobatch-durable');
    const queue = track(
      new Queue(`autobatch-${crypto.randomUUID()}`, {
        embedded: false,
        connection: { host: '127.0.0.1', port: broker.port, poolSize: 1 },
        autoBatch: { enabled: true },
      })
    );

    await Promise.all([
      queue.add('critical-1', { x: 1 }, { durable: true }),
      queue.add('critical-2', { x: 2 }, { durable: true }),
    ]);

    expect(broker.manager.singlePushes).toBe(2);
    expect(broker.manager.batchPushes).toBe(0);
  }, 20_000);

  test('auto-batching can be disabled', async () => {
    const broker = startBroker('autobatch-off');
    const queue = track(
      new Queue(`autobatch-${crypto.randomUUID()}`, {
        embedded: false,
        connection: { host: '127.0.0.1', port: broker.port, poolSize: 1 },
        autoBatch: { enabled: false },
      })
    );

    await Promise.all([queue.add('a', { x: 1 }), queue.add('b', { x: 2 })]);

    expect(broker.manager.batchPushes).toBe(0);
    expect(broker.manager.singlePushes).toBe(2);
  }, 20_000);
});
