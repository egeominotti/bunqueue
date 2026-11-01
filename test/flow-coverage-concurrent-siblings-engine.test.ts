/**
 * Coverage: concurrent terminal failures of siblings under a failParentOnFailure middle
 * node, driven straight at the QueueManager over SQLite.
 *
 * gp (queue A) <- mid (queue B, failParentOnFailure) <- leaves (queue C). Every leaf is
 * pulled first, then all FAILs start in the same tick (`Promise.all`). Two schedules:
 * - "same tick": nothing else is held;
 * - "parent shard held": the test holds the write lock of mid's shard until every leaf is
 *   failed, so every sibling's parent move looks mid up before any can move it (the
 *   interleaving a busy broker produces now and then, forced here).
 *
 * Expected on both: mid and gp fail exactly once (one DLQ entry, one broadcast `failed`
 * event, one parent-level `flow:failed` dashboard event), every leaf is in the DLQ exactly
 * once, nothing stays in waiting-children, and a restart over the same SQLite file changes
 * none of it. The two-level case (a plain parent, two failParentOnFailure children) too.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { jobId, type JobId } from '../src/domain/types/job';
import { SHARD_COUNT, shardIndex } from '../src/shared/hash';
import type { RWLock } from '../src/shared/lock';

type LeafPolicy = 'failParentOnFailure' | 'ignoreDependencyOnFailure';
type Schedule = 'same tick' | 'parent shard held';

const SCHEDULES: Schedule[] = ['same tick', 'parent shard held'];
const [QUEUE_A, QUEUE_B, QUEUE_C] = distinctShardNames([
  'flow-coverage-engine-a',
  'flow-coverage-engine-b',
  'flow-coverage-engine-c',
]);
const directories: string[] = [];
const managers: QueueManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) {
    try {
      manager.shutdown();
    } catch {
      // Already shut down by the scenario.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Deterministic queue names on pairwise distinct shards when the shard count allows. */
function distinctShardNames(prefixes: string[]): string[] {
  const used = new Set<number>();
  return prefixes.map((prefix) => {
    let name = prefix;
    for (
      let n = 1;
      n < 1_000 && SHARD_COUNT >= prefixes.length && used.has(shardIndex(name));
      n++
    ) {
      name = `${prefix}-${n}`;
    }
    used.add(shardIndex(name));
    return name;
  });
}

function tempDataPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bunqueue-flow-coverage-engine-'));
  directories.push(directory);
  return join(directory, 'queue.db');
}

function open(dataPath: string): QueueManager {
  const manager = new QueueManager({ dataPath, stallCheckMs: 60_000 });
  managers.push(manager);
  return manager;
}

function close(manager: QueueManager): void {
  managers.splice(managers.indexOf(manager), 1);
  manager.shutdown();
}

interface Tree {
  readonly gpId: JobId | null;
  readonly midId: JobId;
  readonly leafIds: JobId[];
}

/** [gp(A) <-] mid(B) <- one leaf per policy (C), all durable. */
async function pushTree(
  manager: QueueManager,
  label: string,
  leafPolicies: LeafPolicy[],
  withGrandparent = true
): Promise<Tree> {
  const gpId = withGrandparent ? jobId(`${label}-gp`) : null;
  const midId = jobId(`${label}-mid`);
  const leafIds = leafPolicies.map((_, index) => jobId(`${label}-leaf${index + 1}`));
  if (gpId) {
    await manager.push(QUEUE_A, {
      customId: String(gpId),
      data: { name: 'gp' },
      dependsOn: [midId],
      childrenIds: [midId],
      durable: true,
    });
  }
  await manager.push(QUEUE_B, {
    ...(gpId
      ? {
          failParentOnFailure: true,
          parentId: gpId,
          data: { name: 'mid', __parentId: String(gpId), __parentQueue: QUEUE_A },
        }
      : { data: { name: 'mid' } }),
    customId: String(midId),
    dependsOn: leafIds,
    childrenIds: leafIds,
    durable: true,
  });
  for (let index = 0; index < leafIds.length; index++) {
    await manager.push(QUEUE_C, {
      [leafPolicies[index]]: true,
      customId: String(leafIds[index]),
      data: { name: `leaf${index + 1}`, __parentId: String(midId), __parentQueue: QUEUE_B },
      parentId: midId,
      durable: true,
      maxAttempts: 1,
    });
  }
  return { gpId, midId, leafIds };
}

interface Observed {
  readonly failed: Array<{ jobId: string; error: string | undefined }>;
  readonly flowFailed: Array<Record<string, unknown>>;
}

function observe(manager: QueueManager): Observed {
  const observed: Observed = { failed: [], flowFailed: [] };
  manager.subscribe((event) => {
    if (event.eventType === 'failed') {
      observed.failed.push({ jobId: String(event.jobId), error: event.error });
    }
  });
  manager.setDashboardEmit((event, data) => {
    if (event === 'flow:failed') observed.flowFailed.push(data);
  });
  return observed;
}

/** Pull every leaf, then fail all of them in the same tick under `schedule`. */
async function failLeavesTogether(
  manager: QueueManager,
  tree: Tree,
  schedule: Schedule
): Promise<void> {
  const pulled: string[] = [];
  for (const _ of tree.leafIds) pulled.push(String((await manager.pull(QUEUE_C))?.id));
  expect(pulled.sort()).toEqual(tree.leafIds.map(String).sort());
  const lock = (manager as unknown as { shardLocks: RWLock[] }).shardLocks[shardIndex(QUEUE_B)];
  const gate = schedule === 'parent shard held' ? await lock.acquireWrite() : null;
  const failing = Promise.all(
    tree.leafIds.map((id, index) => manager.fail(id, `boom-leaf${index + 1}`))
  );
  if (gate) {
    try {
      // Every leaf is failed (its parent move now waits on the held lock); with a single
      // shard the leaves' own FAILs queue on the held lock instead.
      const deadline = Date.now() + 10_000;
      for (;;) {
        if (lock.getState().writerWaiting >= tree.leafIds.length) break;
        const states = await Promise.all(tree.leafIds.map((id) => manager.getJobState(id)));
        if (states.every((state) => state === 'failed')) break;
        if (Date.now() > deadline) throw new Error('leaf FAILs never reached the held shard');
        await Bun.sleep(5);
      }
      await Bun.sleep(20);
    } finally {
      gate.release();
    }
  }
  await failing;
  // Let any follow-up (an awaited parent move, a promotion timer) settle.
  await Bun.sleep(100);
}

function dlqIds(manager: QueueManager, queue: string): string[] {
  return manager
    .getDlqEntries(queue)
    .map((entry) => String(entry.job.id))
    .sort();
}

async function expectSettled(manager: QueueManager, tree: Tree): Promise<void> {
  const ids = [tree.midId, ...tree.leafIds, ...(tree.gpId ? [tree.gpId] : [])];
  for (const id of ids) expect(await manager.getJobState(id)).toBe('failed');
  expect(dlqIds(manager, QUEUE_A)).toEqual(tree.gpId ? [String(tree.gpId)] : []);
  expect(dlqIds(manager, QUEUE_B)).toEqual([String(tree.midId)]);
  expect(dlqIds(manager, QUEUE_C)).toEqual(tree.leafIds.map(String).sort());
  for (const queue of [QUEUE_A, QUEUE_B, QUEUE_C]) {
    const counts = manager.getQueueJobCounts(queue);
    expect(counts['waiting-children']).toBe(0);
    expect(counts.waiting + counts.prioritized + counts.active + counts.delayed).toBe(0);
    expect(counts.failed).toBe(dlqIds(manager, queue).length);
  }
}

function eventsFor(observed: Observed, id: JobId): string[] {
  return observed.failed
    .filter((event) => event.jobId === String(id))
    .map((event) => String(event.error));
}

/** Parent-level flow:failed events: emitted on the parent's own queue. */
function parentLevelFlowFailed(observed: Observed, parentId: JobId, queue: string): number {
  return observed.flowFailed.filter(
    (event) => event.parentJobId === String(parentId) && event.queue === queue
  ).length;
}

for (const schedule of SCHEDULES) {
  describe(`flow coverage · concurrent sibling failures at the engine (${schedule})`, () => {
    for (const siblings of [2, 3]) {
      test(`${siblings} failParentOnFailure siblings fail mid and gp exactly once`, async () => {
        const dataPath = tempDataPath();
        const manager = open(dataPath);
        const policies = Array.from({ length: siblings }, () => 'failParentOnFailure' as const);
        const tree = await pushTree(manager, `fpof-x${siblings}`, policies);
        const observed = observe(manager);
        await failLeavesTogether(manager, tree, schedule);

        await expectSettled(manager, tree);
        for (const id of tree.leafIds) expect(eventsFor(observed, id)).toHaveLength(1);
        const midError = manager.getDlqEntries(QUEUE_B)[0].error;
        expect(tree.leafIds.map((id, i) => `Child job ${id} failed: boom-leaf${i + 1}`)).toContain(
          midError ?? ''
        );
        expect(eventsFor(observed, tree.midId)).toEqual([midError ?? '']);
        expect(eventsFor(observed, tree.gpId!)).toEqual([
          `Child job ${tree.midId} failed: ${midError}`,
        ]);
        expect(parentLevelFlowFailed(observed, tree.midId, QUEUE_B)).toBe(1);
        expect(parentLevelFlowFailed(observed, tree.gpId!, QUEUE_A)).toBe(1);

        close(manager);
        await expectSettled(open(dataPath), tree);
      }, 20_000);
    }

    test('two-level: a parent with two failParentOnFailure children fails once', async () => {
      const dataPath = tempDataPath();
      const manager = open(dataPath);
      const policies: LeafPolicy[] = ['failParentOnFailure', 'failParentOnFailure'];
      const tree = await pushTree(manager, 'two-level', policies, false);
      const observed = observe(manager);
      await failLeavesTogether(manager, tree, schedule);

      await expectSettled(manager, tree);
      const parentError = manager.getDlqEntries(QUEUE_B)[0].error;
      expect(eventsFor(observed, tree.midId)).toEqual([parentError ?? '']);
      expect(parentLevelFlowFailed(observed, tree.midId, QUEUE_B)).toBe(1);

      close(manager);
      await expectSettled(open(dataPath), tree);
    }, 20_000);

    for (const order of ['ignore first', 'failParentOnFailure first'] as const) {
      test(`ignore + failParentOnFailure siblings fail mid once (${order})`, async () => {
        const dataPath = tempDataPath();
        const manager = open(dataPath);
        const policies: LeafPolicy[] =
          order === 'ignore first'
            ? ['ignoreDependencyOnFailure', 'failParentOnFailure']
            : ['failParentOnFailure', 'ignoreDependencyOnFailure'];
        const tree = await pushTree(manager, `mixed-${policies[0]}`, policies);
        const fpofIndex = policies.indexOf('failParentOnFailure');
        const observed = observe(manager);
        await failLeavesTogether(manager, tree, schedule);

        await expectSettled(manager, tree);
        const midError = `Child job ${tree.leafIds[fpofIndex]} failed: boom-leaf${fpofIndex + 1}`;
        expect(eventsFor(observed, tree.midId)).toEqual([midError]);
        expect(eventsFor(observed, tree.gpId!)).toEqual([
          `Child job ${tree.midId} failed: ${midError}`,
        ]);
        expect(await manager.getIgnoredChildrenFailures(tree.midId)).toEqual({});
        expect(parentLevelFlowFailed(observed, tree.midId, QUEUE_B)).toBe(1);
        expect(parentLevelFlowFailed(observed, tree.gpId!, QUEUE_A)).toBe(1);

        close(manager);
        const reopened = open(dataPath);
        await expectSettled(reopened, tree);
        expect(await reopened.getIgnoredChildrenFailures(tree.midId)).toEqual({});
      }, 20_000);
    }
  });
}
