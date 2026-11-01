/**
 * Coverage: failParentOnFailure propagation when every level of the flow lives on a
 * different queue (and therefore, with more than one shard, on a different shard).
 *
 * gp (queue A) <- mid (queue B, policy) <- leaf (queue C, failParentOnFailure) must give
 * the same outcomes as the single-queue repro (test/repro-flow-fail-parent-propagation):
 * failParentOnFailure fails gp, ignore/remove/continue release it, no policy keeps it in
 * waiting-children. A four-level failParentOnFailure chain across four queues fails every
 * level. Each DLQ holds its own job exactly once, with the chained error text.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Queue } from '../src/client';
import { SHARD_COUNT, shardIndex } from '../src/shared/hash';
import {
  type CoreE2eHarness,
  MODES,
  closeHarness,
  startHarness,
  waitForState,
} from './docs-guide-support';

type Policy =
  | 'failParentOnFailure'
  | 'ignoreDependencyOnFailure'
  | 'removeDependencyOnFailure'
  | 'continueParentOnFailure';

const WAIT_MS = 15_000;
let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await closeHarness(harness);
  harness = null;
});

/** Queue names on pairwise distinct shards whenever the shard count allows it. */
function distinctShardNames(active: CoreE2eHarness, labels: string[]): string[] {
  const names: string[] = [];
  const used = new Set<number>();
  for (const label of labels) {
    let name = active.unique(label);
    for (let attempt = 0; attempt < 500 && used.has(shardIndex(name)); attempt++) {
      name = active.unique(label);
    }
    if (SHARD_COUNT >= labels.length) expect(used.has(shardIndex(name))).toBe(false);
    used.add(shardIndex(name));
    names.push(name);
  }
  return names;
}

function openQueue(active: CoreE2eHarness, name: string): Queue<unknown> {
  const queue = new Queue<unknown>(name, active.queueOptions());
  active.addCleanup(() => queue.close());
  return queue;
}

/** The DLQ of `queue` holds exactly the given job ids, each exactly once. */
async function expectDlq(
  queue: Queue<unknown>,
  expected: Array<{ id: string; error: string }>
): Promise<void> {
  const entries = await queue.getDlqAsync();
  const ids = entries.map((entry) => entry.job.id).sort();
  expect(ids).toEqual(expected.map((item) => item.id).sort());
  for (const item of expected) {
    const entry = entries.find((candidate) => candidate.job.id === item.id);
    expect(entry?.error).toBe(item.error);
  }
}

for (const mode of MODES) {
  describe(`flow coverage · cross-queue propagation [${mode}]`, () => {
    async function run(midPolicy: Policy | null) {
      harness = await startHarness('flow-coverage-xq', mode);
      const [nameA, nameB, nameC] = distinctShardNames(harness, ['xq-a', 'xq-b', 'xq-c']);
      const queueA = openQueue(harness, nameA);
      const queueB = openQueue(harness, nameB);
      const queueC = openQueue(harness, nameC);
      const ran: string[] = [];
      for (const name of [nameA, nameB, nameC]) {
        harness.worker(name, async (job) => {
          ran.push(job.name);
          if (job.name === 'leaf') throw new Error('boom');
          return { ok: job.name };
        });
      }
      const node = await harness.flow().add({
        name: 'gp',
        queueName: nameA,
        data: {},
        children: [
          {
            name: 'mid',
            queueName: nameB,
            data: {},
            opts: midPolicy ? { [midPolicy]: true } : {},
            children: [
              {
                name: 'leaf',
                queueName: nameC,
                data: {},
                opts: { failParentOnFailure: true, attempts: 1 },
              },
              // Never runs: mid can only leave waiting-children through the leaf failure.
              { name: 'sibling', queueName: nameC, data: {}, opts: { delay: 600_000 } },
            ],
          },
        ],
      });
      const mid = node.children![0];
      const leafId = mid.children![0].job.id;
      await waitForState(queueC, leafId, 'failed', WAIT_MS);
      await waitForState(queueB, mid.job.id, 'failed', WAIT_MS);
      const midError = `Child job ${leafId} failed: boom`;
      await expectDlq(queueC, [{ id: leafId, error: 'boom' }]);
      await expectDlq(queueB, [{ id: mid.job.id, error: midError }]);
      return { queueA, gpId: node.job.id, midId: mid.job.id, midError, ran };
    }

    test('failParentOnFailure on the middle node fails the grandparent on another queue', async () => {
      const { queueA, gpId, midId, midError, ran } = await run('failParentOnFailure');
      await waitForState(queueA, gpId, 'failed', WAIT_MS);
      await expectDlq(queueA, [{ id: gpId, error: `Child job ${midId} failed: ${midError}` }]);
      expect(ran).not.toContain('gp');
      expect(ran.filter((name) => name === 'leaf')).toHaveLength(1);
    }, 30_000);

    test('ignoreDependencyOnFailure on the middle node releases the grandparent', async () => {
      const { queueA, gpId, ran } = await run('ignoreDependencyOnFailure');
      await waitForState(queueA, gpId, 'completed', WAIT_MS);
      expect(ran.filter((name) => name === 'gp')).toHaveLength(1);
      await expectDlq(queueA, []);
    }, 30_000);

    test('removeDependencyOnFailure on the middle node releases the grandparent', async () => {
      const { queueA, gpId, ran } = await run('removeDependencyOnFailure');
      await waitForState(queueA, gpId, 'completed', WAIT_MS);
      expect(ran.filter((name) => name === 'gp')).toHaveLength(1);
      await expectDlq(queueA, []);
    }, 30_000);

    test('continueParentOnFailure on the middle node promotes the grandparent', async () => {
      const { queueA, gpId, ran } = await run('continueParentOnFailure');
      await waitForState(queueA, gpId, 'completed', WAIT_MS);
      expect(ran.filter((name) => name === 'gp')).toHaveLength(1);
      await expectDlq(queueA, []);
    }, 30_000);

    test('control: without a policy on the middle node the grandparent keeps waiting', async () => {
      const { queueA, gpId, ran } = await run(null);
      await Bun.sleep(500);
      expect(await queueA.getJobState(gpId)).toBe('waiting-children');
      expect(ran).not.toContain('gp');
      await expectDlq(queueA, []);
    }, 30_000);

    test('failParentOnFailure propagates through four levels on four queues', async () => {
      harness = await startHarness('flow-coverage-xq4', mode);
      const names = distinctShardNames(harness, ['xq4-root', 'xq4-l1', 'xq4-l2', 'xq4-leaf']);
      const queues = names.map((name) => openQueue(harness!, name));
      const ran: string[] = [];
      for (const name of names) {
        harness.worker(name, async (job) => {
          ran.push(job.name);
          if (job.name === 'leaf') throw new Error('boom');
          return null;
        });
      }
      const fpof = { failParentOnFailure: true };
      const node = await harness.flow().add({
        name: 'root',
        queueName: names[0],
        data: {},
        children: [
          {
            name: 'l1',
            queueName: names[1],
            data: {},
            opts: fpof,
            children: [
              {
                name: 'l2',
                queueName: names[2],
                data: {},
                opts: fpof,
                children: [
                  { name: 'leaf', queueName: names[3], data: {}, opts: { ...fpof, attempts: 1 } },
                ],
              },
            ],
          },
        ],
      });
      const l1 = node.children![0];
      const l2 = l1.children![0];
      const leaf = l2.children![0];
      const chain = [node.job.id, l1.job.id, l2.job.id, leaf.job.id];
      await waitForState(queues[0], node.job.id, 'failed', WAIT_MS);
      for (let level = 0; level < chain.length; level++) {
        expect(await queues[level].getJobState(chain[level])).toBe('failed');
      }
      // Each level's error wraps the one below it.
      let error = 'boom';
      for (let level = chain.length - 1; level >= 0; level--) {
        await expectDlq(queues[level], [{ id: chain[level], error }]);
        error = `Child job ${chain[level]} failed: ${error}`;
      }
      expect(ran).toEqual(['leaf']);
    }, 30_000);
  });
}
