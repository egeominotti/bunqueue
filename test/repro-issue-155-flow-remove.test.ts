/**
 * Issue #155 B: a FlowProducer job's `remove()` follows the Queue's removal rule.
 *
 * Over TCP the flow job threw on any Cancel refusal, so removing a job that no longer
 * exists rejected while every other `job.remove()` resolved; the embedded fallback
 * ignored the outcome, so an active job "removed" fine and kept running. Both now go
 * through `removeJob` (src/client/jobRemoval.ts): a missing job resolves, an active job
 * rejects naming its state, a completed job is removed.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Job } from '../src/client';
import { createFlowJobObject } from '../src/client/flowJobFactory';
import { CoreE2eHarness } from './core-e2e/support/harness';

setDefaultTimeout(30_000);

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function waitForState(read: () => Promise<string>, expected: string): Promise<void> {
  for (let i = 0; i < 1_000; i++) {
    if ((await read()) === expected) return;
    await Bun.sleep(5);
  }
  throw new Error(`state never became ${expected} (last: ${await read()})`);
}

for (const mode of ['embedded', 'tcp'] as const) {
  describe(`FlowProducer job.remove() [${mode}]`, () => {
    test('active rejects naming the state, completed is removed, missing resolves', async () => {
      harness = await CoreE2eHarness.start(mode, 'i155-flow-remove');
      // The Queue opens the embedded engine on the harness database before the flow.
      const queue = harness.queue<{ n: number }>('flow-remove');
      const flow = harness.flow();
      const node = await flow.add({ name: 'node', queueName: queue.name, data: { n: 1 } });
      const release = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      harness.worker(queue.name, async (_job: Job<{ n: number }>) => {
        started.resolve();
        await release.promise;
        return { done: true };
      });

      await started.promise;
      await expect(node.job.remove()).rejects.toThrow(/current state: active/);
      expect(await queue.getJobState(node.job.id)).toBe('active');

      release.resolve();
      await waitForState(() => queue.getJobState(node.job.id), 'completed');
      await expect(node.job.remove()).resolves.toBeUndefined();
      expect(await queue.getJobState(node.job.id)).toBe('unknown');
      expect(await queue.getJob(node.job.id)).toBeNull();

      // Missing now: a second removal resolves (idempotent cleanup).
      await expect(node.job.remove()).resolves.toBeUndefined();
    });
  });
}

describe('flow job built without transport callbacks [embedded]', () => {
  test('the embedded fallback reports a refusal instead of ignoring it', async () => {
    harness = await CoreE2eHarness.start('embedded', 'i155-flow-fallback');
    const queue = harness.queue<{ n: number }>('flow-fallback');
    const added = await queue.add('own', { n: 1 }, { durable: true });
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    harness.worker(queue.name, async () => {
      started.resolve();
      await release.promise;
      return { done: true };
    });
    const job = createFlowJobObject(added.id, 'own', { n: 1 }, queue.name, {
      callbacks: { embedded: true },
    });

    await started.promise;
    await expect(job.remove()).rejects.toThrow(/current state: active/);

    release.resolve();
    await waitForState(() => queue.getJobState(added.id), 'completed');
    await expect(job.remove()).resolves.toBeUndefined();
    expect(await queue.getJobState(added.id)).toBe('unknown');
    await expect(job.remove()).resolves.toBeUndefined();
  });
});
