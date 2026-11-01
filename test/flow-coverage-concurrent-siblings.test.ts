/**
 * Coverage: two siblings that fail at the same moment under a middle node with
 * failParentOnFailure, through the public client API (embedded and TCP).
 *
 * gp (queue A) <- mid (queue B, failParentOnFailure) <- [leaf1, leaf2] (queue C). Every
 * leaf of every flow is held by a barrier until all are active; the test then holds the
 * write lock of mid's shard, lets every leaf throw, waits until every leaf is failed and
 * releases the lock, so both siblings' parent moves reach mid concurrently on every run
 * (without the gate the same race occurs only now and then).
 *
 * Expected: mid and gp fail exactly once (one DLQ entry, one `failed` QueueEvents event
 * each, with the chained "Child job <id> failed: ..." reason), each leaf is in the DLQ
 * exactly once, and no queue keeps a job in waiting-children. The mixed case gives leaf1
 * ignoreDependencyOnFailure and leaf2 failParentOnFailure: mid still fails exactly once,
 * because of leaf2, and reports no ignored failure once it has failed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Queue } from '../src/client';
import type { RWLock } from '../src/shared/lock';
import { SHARD_COUNT, shardIndex } from '../src/shared/hash';
import {
  type CoreE2eHarness,
  MODES,
  closeHarness,
  queueEvents,
  startHarness,
  waitForState,
  waitUntil,
} from './docs-guide-support';

type LeafPolicy = 'failParentOnFailure' | 'ignoreDependencyOnFailure';

const FLOWS = 4;
const WAIT_MS = 15_000;
let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await closeHarness(harness);
  harness = null;
});

interface FailedRecord {
  readonly jobId: string;
  readonly failedReason: string;
}

/** Queue names on pairwise distinct shards whenever the shard count allows it. */
function distinctShardQueues(active: CoreE2eHarness, labels: string[]): Queue<unknown>[] {
  const used = new Set<number>();
  return labels.map((label) => {
    let name = active.unique(label);
    for (let attempt = 0; attempt < 500 && used.has(shardIndex(name)); attempt++) {
      name = active.unique(label);
    }
    if (SHARD_COUNT >= labels.length) expect(used.has(shardIndex(name))).toBe(false);
    used.add(shardIndex(name));
    const queue = new Queue<unknown>(name, active.queueOptions());
    active.addCleanup(() => queue.close());
    return queue;
  });
}

function shardLock(active: CoreE2eHarness, queueName: string): RWLock {
  const manager = active.brokerManager() as unknown as { shardLocks: RWLock[] };
  return manager.shardLocks[shardIndex(queueName)];
}

async function collectFailed(active: CoreE2eHarness, name: string): Promise<FailedRecord[]> {
  const records: FailedRecord[] = [];
  const events = queueEvents(active, name);
  events.on('failed', ({ jobId, failedReason }) => records.push({ jobId, failedReason }));
  await events.waitUntilReady();
  return records;
}

function reasonsFor(records: FailedRecord[], id: string): string[] {
  return records.filter((record) => record.jobId === id).map((record) => record.failedReason);
}

async function dlqIds(queue: Queue<unknown>): Promise<string[]> {
  return (await queue.getDlqAsync()).map((entry) => entry.job.id).sort();
}

async function runConcurrentSiblings(mode: (typeof MODES)[number], leaf1Policy: LeafPolicy) {
  harness = await startHarness('flow-coverage-siblings', mode);
  const active = harness;
  const [queueA, queueB, queueC] = distinctShardQueues(active, ['sib-a', 'sib-b', 'sib-c']);
  const failedA = await collectFailed(active, queueA.name);
  const failedB = await collectFailed(active, queueB.name);
  const failedC = await collectFailed(active, queueC.name);

  const ran: string[] = [];
  let arrived = 0;
  const go = Promise.withResolvers<void>();
  for (const queue of [queueA, queueB]) {
    active.worker(queue.name, async (job) => {
      ran.push(job.name);
      return null;
    });
  }
  active.worker(
    queueC.name,
    async (job) => {
      ran.push(job.name);
      arrived++;
      await go.promise;
      throw new Error(`boom-${job.name}`);
    },
    { concurrency: FLOWS * 2 }
  );

  const flow = active.flow();
  const nodes = await Promise.all(
    Array.from({ length: FLOWS }, (_, index) =>
      flow.add({
        name: 'gp',
        queueName: queueA.name,
        data: { index },
        children: [
          {
            name: 'mid',
            queueName: queueB.name,
            data: { index },
            opts: { failParentOnFailure: true },
            children: [
              {
                name: 'leaf1',
                queueName: queueC.name,
                data: { index },
                opts: { [leaf1Policy]: true, attempts: 1 },
              },
              {
                name: 'leaf2',
                queueName: queueC.name,
                data: { index },
                opts: { failParentOnFailure: true, attempts: 1 },
              },
            ],
          },
        ],
      })
    )
  );
  const flows = nodes.map((node) => {
    const mid = node.children![0];
    return {
      gpId: node.job.id,
      midId: mid.job.id,
      leaf1Id: mid.children![0].job.id,
      leaf2Id: mid.children![1].job.id,
    };
  });
  const leafIds = flows.flatMap((ids) => [ids.leaf1Id, ids.leaf2Id]);

  await waitUntil(() => arrived === leafIds.length, 'every leaf to be active', WAIT_MS);
  const gate = await shardLock(active, queueB.name).acquireWrite();
  try {
    go.resolve();
    await waitUntil(
      async () => {
        for (const id of leafIds) if ((await queueC.getJobState(id)) !== 'failed') return false;
        return true;
      },
      'every leaf to be failed while the middle shard is held',
      WAIT_MS
    );
    await Bun.sleep(50);
  } finally {
    gate.release();
  }

  for (const ids of flows) {
    await waitForState(queueA, ids.gpId, 'failed', WAIT_MS);
    expect(await queueB.getJobState(ids.midId)).toBe('failed');
  }
  // Let any late duplicate event, DLQ move or promotion surface before asserting.
  await Bun.sleep(500);

  expect(await dlqIds(queueA)).toEqual(flows.map((ids) => ids.gpId).sort());
  expect(await dlqIds(queueB)).toEqual(flows.map((ids) => ids.midId).sort());
  expect(await dlqIds(queueC)).toEqual([...leafIds].sort());
  for (const queue of [queueA, queueB, queueC]) {
    expect(await queue.getWaitingChildrenCount()).toBe(0);
    const counts = await queue.getJobCountsAsync();
    expect(counts.waiting + counts.prioritized + counts.active + counts.delayed).toBe(0);
  }
  for (const id of leafIds) expect(reasonsFor(failedC, id)).toHaveLength(1);
  expect(ran.filter((name) => name === 'gp' || name === 'mid')).toEqual([]);
  return { queueA, queueB, flows, failedA, failedB };
}

for (const mode of MODES) {
  describe(`flow coverage · concurrent sibling failures [${mode}]`, () => {
    test('two failParentOnFailure siblings failing together fail mid and gp exactly once', async () => {
      const { queueA, queueB, flows, failedA, failedB } = await runConcurrentSiblings(
        mode,
        'failParentOnFailure'
      );
      const dlqA = await queueA.getDlqAsync();
      const dlqB = await queueB.getDlqAsync();
      for (const ids of flows) {
        const midEntry = dlqB.find((entry) => entry.job.id === ids.midId);
        expect([
          `Child job ${ids.leaf1Id} failed: boom-leaf1`,
          `Child job ${ids.leaf2Id} failed: boom-leaf2`,
        ]).toContain(midEntry?.error ?? '');
        const gpError = `Child job ${ids.midId} failed: ${midEntry?.error}`;
        expect(dlqA.find((entry) => entry.job.id === ids.gpId)?.error).toBe(gpError);
        expect(reasonsFor(failedA, ids.gpId)).toEqual([gpError]);
        // One `failed` event for mid, with the reason its DLQ entry records.
        expect(reasonsFor(failedB, ids.midId)).toEqual([midEntry?.error ?? '']);
      }
    }, 45_000);

    test('ignore + failParentOnFailure siblings failing together fail mid once, by leaf2', async () => {
      const { queueB, flows, failedA, failedB } = await runConcurrentSiblings(
        mode,
        'ignoreDependencyOnFailure'
      );
      for (const ids of flows) {
        const midReason = `Child job ${ids.leaf2Id} failed: boom-leaf2`;
        expect(reasonsFor(failedB, ids.midId)).toEqual([midReason]);
        expect(reasonsFor(failedA, ids.gpId)).toEqual([
          `Child job ${ids.midId} failed: ${midReason}`,
        ]);
        // A failed parent reports no ignored failure, whichever sibling landed first.
        const mid = await queueB.getJob(ids.midId);
        expect(mid).not.toBeNull();
        expect(await mid!.getIgnoredChildrenFailures()).toEqual({});
      }
    }, 45_000);
  });
}
