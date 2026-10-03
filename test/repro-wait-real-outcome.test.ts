import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { QueueEvents } from '../src/client';
import type { QueueManager } from '../src/application/queueManager';
import type { BackgroundContext } from '../src/application/types';
import { handleStalledJob } from '../src/application/stallDetection';
import type { Job } from '../src/domain/types/job';
import { StallAction } from '../src/domain/types/stall';
import { processingShardIndex } from '../src/shared/hash';
import { CoreE2eHarness } from './core-e2e/support/harness';

// With QueueEvents and no TTL a wait used to settle only on a `completed` or terminal
// `failed` event. Found by the skeptic review of the first jobWait.ts: jobs the stall
// detector moves to the DLQ (it broadcasts only `stalled`), jobs removed or drained, a
// QueueEvents closed mid-wait (close() removes every listener), and events lost while a
// TCP QueueEvents reconnects all left the wait pending forever. A wait now re-reads the
// job on hints for it (`stalled`, `removed`, a re-subscribed QueueEvents), falls back to
// its own transport when its QueueEvents closes, re-reads periodically as a safety net,
// and settles with `Job <id> not found` once the job no longer exists.

setDefaultTimeout(30_000);

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

type Settled = { value: unknown } | { error: string } | 'pending';

/** The wait's outcome, or 'pending' when it has not settled within `ms`. */
function settledWithin(wait: Promise<unknown>, ms: number): Promise<Settled> {
  return Promise.race([
    wait.then(
      (value) => ({ value }),
      (error: unknown) => ({ error: (error as Error).message })
    ),
    Bun.sleep(ms).then(() => 'pending' as const),
  ]);
}

function queueEvents(h: CoreE2eHarness, name: string): QueueEvents {
  const events = new QueueEvents(
    name,
    h.mode === 'tcp'
      ? { embedded: false, connection: h.connection() }
      : { embedded: true, dataPath: h.dataPath }
  );
  h.addCleanup(() => events.close());
  return events;
}

function background(manager: QueueManager): BackgroundContext {
  return (
    manager as unknown as { contextFactory: { getBackgroundContext(): BackgroundContext } }
  ).contextFactory.getBackgroundContext();
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error('condition not reached within 10s');
}

/** The dedicated TCP client behind a QueueEvents. */
interface EventClient {
  send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
  socket: { end(): void } | null;
}

function eventClient(events: QueueEvents): EventClient {
  return (events as unknown as { subscription: { client: EventClient } }).subscription.client;
}

for (const mode of ['embedded', 'tcp'] as const) {
  describe(`a wait settles on the job's real outcome [${mode}]`, () => {
    test('a job the stall detector moves to the DLQ', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-real-stall');
      const queue = harness.queue('stall');
      const events = queueEvents(harness, queue.name);
      await events.waitUntilReady();
      const job = await queue.add('stall', {}, { attempts: 3, durable: true });
      const manager = harness.brokerManager();
      const pulled = await manager.pull(queue.name);
      expect(String(pulled?.id)).toBe(job.id);
      // Windows shorter than the 5s safety-net re-read: the `stalled` hint must settle them.
      const waits = Promise.all([
        settledWithin(job.waitUntilFinished(events), 3_000),
        settledWithin(job.waitUntilFinished(null, 30_000), 3_000),
      ]);
      await Bun.sleep(50);

      const ctx = background(manager);
      const active = ctx.processingShards[processingShardIndex(pulled!.id)].get(pulled!.id);
      expect(await handleStalledJob(active as Job, StallAction.MoveToDlq, ctx)).toBe(true);
      expect(await queue.getJobState(job.id)).toBe('failed');

      for (const settled of await waits) {
        expect(settled).toHaveProperty('error');
        expect((settled as { error: string }).error).not.toMatch(/timed out/);
      }
    });

    test('a removed job', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-real-removed');
      const queue = harness.queue('removed');
      const events = queueEvents(harness, queue.name);
      await events.waitUntilReady();
      const job = await queue.add('removed', {}, { durable: true });
      const wait = settledWithin(job.waitUntilFinished(events), 3_000);
      await Bun.sleep(50);

      await queue.remove(job.id);

      expect(await wait).toEqual({ error: `Job ${job.id} not found` });
    });

    test('a drained job, which has no event of its own', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-real-drained');
      const queue = harness.queue('drained');
      const events = queueEvents(harness, queue.name);
      await events.waitUntilReady();
      const job = await queue.add('drained', {}, { durable: true });
      const wait = settledWithin(job.waitUntilFinished(events), 10_000);
      await Bun.sleep(50);

      await queue.drain();

      // The safety-net re-read runs 5s into the wait.
      expect(await wait).toEqual({ error: `Job ${job.id} not found` });
    });

    test('a wait outlives the QueueEvents it listens to', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-real-closed');
      const queue = harness.queue('closed');
      const events = queueEvents(harness, queue.name);
      await events.waitUntilReady();
      const job = await queue.add('closed', {}, { durable: true });
      const wait = settledWithin(job.waitUntilFinished(events), 3_000);
      await Bun.sleep(50);

      events.close();
      harness.worker(queue.name, () => 'done');

      expect(await wait).toEqual({ value: 'done' });
    });

    test('a job removed on completion before the wait started', async () => {
      harness = await CoreE2eHarness.start(mode, 'wait-real-remove-on-complete');
      const queue = harness.queue('gone');
      const events = queueEvents(harness, queue.name);
      await events.waitUntilReady();
      harness.worker(queue.name, () => 'done');
      const job = await queue.add('gone', {}, { removeOnComplete: true, durable: true });
      await until(async () => (await queue.getJobState(job.id)) === 'unknown');

      const notFound = { error: `Job ${job.id} not found` };
      expect(await settledWithin(job.waitUntilFinished(events), 2_000)).toEqual(notFound);
      expect(await settledWithin(job.waitUntilFinished(null, 10_000), 2_000)).toEqual(notFound);
    });
  });
}

describe('a TCP QueueEvents that reconnects', () => {
  test('a wait re-reads the job once the QueueEvents subscribes again', async () => {
    harness = await CoreE2eHarness.start('tcp', 'wait-real-resubscribe');
    const queue = harness.queue('resubscribe');
    const events = queueEvents(harness, queue.name);
    await events.waitUntilReady();
    const job = await queue.add('resubscribe', {}, { durable: true });
    // Shorter than the 5s safety-net re-read: the re-subscription must trigger the read.
    const wait = settledWithin(job.waitUntilFinished(events), 3_000);
    await Bun.sleep(50);

    // The broker stops sending events, so the completion below is lost.
    const client = eventClient(events);
    expect((await client.send({ cmd: 'UnsubscribeEvents' })).ok).toBe(true);
    const manager = harness.brokerManager();
    const pulled = await manager.pull(queue.name);
    await manager.ack(pulled!.id, 'done');
    expect(await queue.getJobState(job.id)).toBe('completed');
    await Bun.sleep(100);

    // A dropped connection: the QueueEvents reconnects and subscribes again.
    client.socket?.end();

    expect(await wait).toEqual({ value: 'done' });
  });
});
