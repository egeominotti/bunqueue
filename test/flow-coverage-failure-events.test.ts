/**
 * Coverage: the events a failParentOnFailure chain emits, level by level, as observed
 * through public APIs (QueueEvents in embedded and TCP mode) and the broker's dashboard
 * emitter.
 *
 * - QueueEvents on one queue sees exactly one terminal `failed` per level, in order
 *   leaf -> mid -> gp, with each reason wrapping the one below it
 *   ("Child job <leaf> failed: boom", then "Child job <mid> failed: Child job <leaf> ...").
 *   A non-terminal leaf attempt is reported with `terminal: false` and moves nobody.
 * - Across three queues each QueueEvents stream sees only its own level.
 * - Dashboard `flow:failed` (docs/features/flow-producer.md): each failed pair is reported
 *   once at child level (on the child's queue) and once when the next parent is failed
 *   (on that parent's queue); a middle node with ignore/remove/continue reports only the
 *   child-level event toward the grandparent; a middle node without a policy none.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Queue } from '../src/client';
import {
  type CoreE2eHarness,
  MODES,
  closeHarness,
  queueEvents,
  startHarness,
  waitForState,
  waitUntil,
} from './docs-guide-support';

type Policy =
  | 'failParentOnFailure'
  | 'ignoreDependencyOnFailure'
  | 'removeDependencyOnFailure'
  | 'continueParentOnFailure';

interface FailedRecord {
  readonly queue: string;
  readonly jobId: string;
  readonly failedReason: string;
  readonly terminal: boolean;
}

interface FlowFailedRecord {
  readonly parentJobId: unknown;
  readonly failedChildId: unknown;
  readonly queue: unknown;
  readonly error: unknown;
}

const WAIT_MS = 15_000;
let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await closeHarness(harness);
  harness = null;
});

function openQueue(active: CoreE2eHarness, label: string): Queue<unknown> {
  const queue = new Queue<unknown>(active.unique(label), active.queueOptions());
  active.addCleanup(() => queue.close());
  return queue;
}

async function recordFailed(
  active: CoreE2eHarness,
  name: string,
  into: FailedRecord[]
): Promise<void> {
  const events = queueEvents(active, name);
  events.on('failed', ({ jobId, failedReason, terminal }) =>
    into.push({ queue: name, jobId, failedReason, terminal: terminal !== false })
  );
  await events.waitUntilReady();
}

function recordFlowFailed(active: CoreE2eHarness): FlowFailedRecord[] {
  const records: FlowFailedRecord[] = [];
  active.brokerManager().setDashboardEmit((event, data) => {
    if (event !== 'flow:failed') return;
    const { parentJobId, failedChildId, queue, error } = data;
    records.push({ parentJobId, failedChildId, queue, error });
  });
  return records;
}

function failingWorkers(active: CoreE2eHarness, names: string[], ran: string[]): void {
  for (const name of names) {
    active.worker(name, async (job) => {
      ran.push(job.name);
      if (job.name === 'leaf') throw new Error('boom');
      return { ok: job.name };
    });
  }
}

for (const mode of MODES) {
  describe(`flow coverage · failure events across levels [${mode}]`, () => {
    test('QueueEvents reports leaf, mid and gp failures once each, in order, chained', async () => {
      harness = await startHarness('flow-coverage-events', mode);
      const queue = openQueue(harness, 'events-one');
      const failed: FailedRecord[] = [];
      await recordFailed(harness, queue.name, failed);
      const ran: string[] = [];
      failingWorkers(harness, [queue.name], ran);
      const fpof = { failParentOnFailure: true };
      const node = await harness.flow().add({
        name: 'gp',
        queueName: queue.name,
        data: {},
        children: [
          {
            name: 'mid',
            queueName: queue.name,
            data: {},
            opts: fpof,
            children: [
              {
                name: 'leaf',
                queueName: queue.name,
                data: {},
                // The first attempt is retried: it must not move any parent.
                opts: { ...fpof, attempts: 2, backoff: 10 },
              },
            ],
          },
        ],
      });
      const mid = node.children![0];
      const leafId = mid.children![0].job.id;
      await waitForState(queue, node.job.id, 'failed', WAIT_MS);
      await waitUntil(() => failed.length >= 4, 'four failed events', WAIT_MS);
      await Bun.sleep(300);

      const midReason = `Child job ${leafId} failed: boom`;
      const gpReason = `Child job ${mid.job.id} failed: ${midReason}`;
      expect(failed).toEqual([
        { queue: queue.name, jobId: leafId, failedReason: 'boom', terminal: false },
        { queue: queue.name, jobId: leafId, failedReason: 'boom', terminal: true },
        { queue: queue.name, jobId: mid.job.id, failedReason: midReason, terminal: true },
        { queue: queue.name, jobId: node.job.id, failedReason: gpReason, terminal: true },
      ]);
      expect(ran).toEqual(['leaf', 'leaf']);
      const dlq = await queue.getDlqAsync();
      expect(dlq.find((entry) => entry.job.id === mid.job.id)?.error).toBe(midReason);
      expect(dlq.find((entry) => entry.job.id === node.job.id)?.error).toBe(gpReason);
    }, 30_000);

    test('three queues: each stream sees its own level, dashboard reports every pair twice', async () => {
      harness = await startHarness('flow-coverage-events-xq', mode);
      const queueA = openQueue(harness, 'events-a');
      const queueB = openQueue(harness, 'events-b');
      const queueC = openQueue(harness, 'events-c');
      const failed: FailedRecord[] = [];
      for (const queue of [queueA, queueB, queueC]) await recordFailed(harness, queue.name, failed);
      const flowFailed = recordFlowFailed(harness);
      const ran: string[] = [];
      failingWorkers(harness, [queueA.name, queueB.name, queueC.name], ran);
      const fpof = { failParentOnFailure: true };
      const node = await harness.flow().add({
        name: 'gp',
        queueName: queueA.name,
        data: {},
        children: [
          {
            name: 'mid',
            queueName: queueB.name,
            data: {},
            opts: fpof,
            children: [
              { name: 'leaf', queueName: queueC.name, data: {}, opts: { ...fpof, attempts: 1 } },
            ],
          },
        ],
      });
      const gpId = node.job.id;
      const midId = node.children![0].job.id;
      const leafId = node.children![0].children![0].job.id;
      await waitForState(queueA, gpId, 'failed', WAIT_MS);
      await waitUntil(() => failed.length >= 3, 'three failed events', WAIT_MS);
      await Bun.sleep(300);

      const midReason = `Child job ${leafId} failed: boom`;
      const gpReason = `Child job ${midId} failed: ${midReason}`;
      const byQueue = (queue: Queue<unknown>) =>
        failed
          .filter((record) => record.queue === queue.name)
          .map(({ jobId, failedReason }) => [jobId, failedReason]);
      expect(byQueue(queueC)).toEqual([[leafId, 'boom']]);
      expect(byQueue(queueB)).toEqual([[midId, midReason]]);
      expect(byQueue(queueA)).toEqual([[gpId, gpReason]]);
      expect(failed).toHaveLength(3);
      expect(flowFailed).toEqual([
        { parentJobId: midId, failedChildId: leafId, queue: queueC.name, error: 'boom' },
        { parentJobId: midId, failedChildId: leafId, queue: queueB.name, error: 'boom' },
        { parentJobId: gpId, failedChildId: midId, queue: queueB.name, error: midReason },
        { parentJobId: gpId, failedChildId: midId, queue: queueA.name, error: midReason },
      ]);
      expect(ran).toEqual(['leaf']);
    }, 30_000);

    const releasing: Array<Policy | null> = [
      'ignoreDependencyOnFailure',
      'removeDependencyOnFailure',
      'continueParentOnFailure',
      null,
    ];
    for (const midPolicy of releasing) {
      test(`mid with ${midPolicy ?? 'no policy'}: gp is not failed, events stop at mid`, async () => {
        harness = await startHarness('flow-coverage-events-policy', mode);
        const queueA = openQueue(harness, 'events-pa');
        const queueB = openQueue(harness, 'events-pb');
        const queueC = openQueue(harness, 'events-pc');
        const failed: FailedRecord[] = [];
        for (const queue of [queueA, queueB, queueC]) {
          await recordFailed(harness, queue.name, failed);
        }
        const flowFailed = recordFlowFailed(harness);
        const ran: string[] = [];
        failingWorkers(harness, [queueA.name, queueB.name, queueC.name], ran);
        const node = await harness.flow().add({
          name: 'gp',
          queueName: queueA.name,
          data: {},
          children: [
            {
              name: 'mid',
              queueName: queueB.name,
              data: {},
              opts: midPolicy ? { [midPolicy]: true } : {},
              children: [
                {
                  name: 'leaf',
                  queueName: queueC.name,
                  data: {},
                  opts: { failParentOnFailure: true, attempts: 1 },
                },
              ],
            },
          ],
        });
        const gpId = node.job.id;
        const midId = node.children![0].job.id;
        const leafId = node.children![0].children![0].job.id;
        await waitForState(queueB, midId, 'failed', WAIT_MS);
        await waitForState(queueA, gpId, midPolicy ? 'completed' : 'waiting-children', WAIT_MS);
        await Bun.sleep(300);

        const midReason = `Child job ${leafId} failed: boom`;
        expect(failed.map(({ jobId, failedReason }) => [jobId, failedReason])).toEqual([
          [leafId, 'boom'],
          [midId, midReason],
        ]);
        const expected: FlowFailedRecord[] = [
          { parentJobId: midId, failedChildId: leafId, queue: queueC.name, error: 'boom' },
          { parentJobId: midId, failedChildId: leafId, queue: queueB.name, error: 'boom' },
        ];
        if (midPolicy) {
          expected.push({
            parentJobId: gpId,
            failedChildId: midId,
            queue: queueB.name,
            error: midReason,
          });
        }
        expect(flowFailed).toEqual(expected);
        expect(ran.filter((name) => name === 'gp')).toHaveLength(midPolicy ? 1 : 0);
        expect(await queueA.getJobState(gpId)).toBe(midPolicy ? 'completed' : 'waiting-children');
      }, 30_000);
    }
  });
}
