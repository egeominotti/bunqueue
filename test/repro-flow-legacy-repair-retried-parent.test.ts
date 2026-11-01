/**
 * The startup repair of legacy stuck flow parents must not re-apply a failure that the
 * current version already applied and someone then undid. A parent failed by its
 * child's `failParentOnFailure` and retried from the DLQ keeps that child in
 * `dependsOn`; a new child linked before the parent runs puts it back in
 * `waiting-children` with an edge on the old failed child and no outbox record (the
 * applied `fail` record was deleted). That parent was released, not stuck: a restart
 * must leave it waiting for its new child, even when its timeline is full and the
 * retry left no timeline entry. A parent that was running when its child failed was
 * never eligible either (no version applies a policy to an active parent).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { FailureReason } from '../src/domain/types/dlq';
import { MAX_TIMELINE_ENTRIES } from '../src/domain/job/constants';
import { jobId, type JobId } from '../src/domain/types/job';
import { SqliteStorage } from '../src/infrastructure/persistence/sqlite';
import {
  cleanupLegacyFlowState,
  close,
  flowFailureRows,
  moveToDlqLikeOlderVersion,
  open,
  QUEUE,
  RECOVERY_ERROR,
  tempDataPath,
  writeChain,
} from './support/legacy-flow-state';

afterEach(cleanupLegacyFlowState);

function rewriteParentTimeline(
  dataPath: string,
  parent: JobId,
  edit: (timeline: Array<{ state: string; timestamp: number }>) => void
): void {
  const storage = new SqliteStorage({ path: dataPath });
  try {
    const job = storage.getJob(parent)!;
    edit(job.timeline as Array<{ state: string; timestamp: number }>);
    storage.updateFlowParentResolution(job, 'waiting-children');
  } finally {
    storage.close();
  }
}

/** Fail the child (policy applied now), retry the parent, link a new child, restart. */
async function retryThenLinkThenRestart(dataPath: string, label: string): Promise<JobId> {
  const [parent, child] = await writeChain(dataPath, label, ['failParentOnFailure']);
  const live = open(dataPath);
  const pulled = await live.pull(QUEUE);
  expect(String(pulled?.id)).toBe(String(child));
  await live.fail(child, 'boom');
  expect(await live.getJobState(parent)).toBe('failed');
  expect(live.retryDlq(QUEUE, parent)).toBe(1);
  expect(await live.getJobState(parent)).toBe('waiting');
  await live.push(QUEUE, {
    customId: `${label}-c2`,
    parentId: parent,
    data: { __parentId: String(parent), __parentQueue: QUEUE },
    durable: true,
  });
  expect(await live.getJobState(parent)).toBe('waiting-children');
  expect(flowFailureRows(dataPath)).toEqual([]);
  close(live);
  return parent;
}

describe('startup repair never re-applies a failure to a released parent', () => {
  test('a parent retried from the DLQ and given a new child keeps waiting', async () => {
    const dataPath = tempDataPath();
    const parent = await retryThenLinkThenRestart(dataPath, 'retry-link');

    const restarted = open(dataPath);
    expect(await restarted.getJobState(parent)).toBe('waiting-children');
    expect((await restarted.getJob(parent))?.dependsOn.map(String)).toContain('retry-link-c2');
    expect(flowFailureRows(dataPath)).toEqual([]);
    close(restarted);
  });

  test('the retry is recognized even when the parent timeline is full', async () => {
    const dataPath = tempDataPath();
    const [parent] = await writeChain(dataPath, 'full', ['failParentOnFailure']);
    // A full timeline records neither the retry nor a later run of the parent.
    rewriteParentTimeline(dataPath, parent, (timeline) => {
      while (timeline.length < MAX_TIMELINE_ENTRIES) {
        timeline.push({ state: 'waiting-children', timestamp: 1_000 + timeline.length });
      }
    });
    await retryWithFullTimelineThenRestart(dataPath, parent);
  });

  test('a parent that was running when its child failed is not repaired', async () => {
    const dataPath = tempDataPath();
    const [parent, child] = await writeChain(dataPath, 'was-active', ['failParentOnFailure']);
    // Running after it was created, and still running when the child failed.
    rewriteParentTimeline(dataPath, parent, (timeline) => {
      timeline.push({ state: 'active', timestamp: Date.now() });
    });
    await Bun.sleep(5);
    moveToDlqLikeOlderVersion(dataPath, child, FailureReason.MaxAttemptsExceeded, RECOVERY_ERROR);

    const manager = open(dataPath);
    expect(await manager.getJobState(parent)).toBe('waiting-children');
    expect(flowFailureRows(dataPath)).toEqual([]);
    close(manager);
  });

  test('a stuck parent that only gained a new child after the failure is repaired', async () => {
    const dataPath = tempDataPath();
    const [parent, child] = await writeChain(dataPath, 'stuck-linked', ['failParentOnFailure']);
    moveToDlqLikeOlderVersion(dataPath, child, FailureReason.MaxAttemptsExceeded, RECOVERY_ERROR);
    rewriteParentTimeline(dataPath, parent, (timeline) => {
      timeline.push({ state: 'waiting-children', timestamp: Date.now() + 1_000 });
    });

    const manager = open(dataPath);
    expect(await manager.getJobState(parent)).toBe('failed');
    close(manager);
  });
});

async function retryWithFullTimelineThenRestart(dataPath: string, parent: JobId): Promise<void> {
  const live = open(dataPath);
  const child = jobId('full-n1');
  const pulled = await live.pull(QUEUE);
  expect(String(pulled?.id)).toBe(String(child));
  await live.fail(child, 'boom');
  expect(await live.getJobState(parent)).toBe('failed');
  expect(live.retryDlq(QUEUE, parent)).toBe(1);
  await live.push(QUEUE, {
    customId: 'full-c2',
    parentId: parent,
    data: { __parentId: String(parent), __parentQueue: QUEUE },
    durable: true,
  });
  const retried = await live.getJob(parent);
  expect(retried?.timeline).toHaveLength(MAX_TIMELINE_ENTRIES);
  close(live);

  const restarted = open(dataPath);
  expect(await restarted.getJobState(parent)).toBe('waiting-children');
  expect(flowFailureRows(dataPath)).toEqual([]);
  close(restarted);
}
