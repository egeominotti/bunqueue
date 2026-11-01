/**
 * Startup repair of flow parents left stuck by older versions: everything it must not
 * touch. A child without a policy (documented default), a discarded child, a child
 * still retrying, parents that are not waiting or ran after the child failed, and an
 * existing outbox record (never replaced). State is written as in
 * repro-flow-legacy-stuck-parent-repair.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { FailureReason } from '../src/domain/types/dlq';
import {
  cleanupLegacyFlowState,
  close,
  flowFailureRows,
  moveToDlqLikeOlderVersion,
  open,
  QUEUE,
  sql,
  tempDataPath,
  writeChain,
} from './support/legacy-flow-state';
import { SqliteStorage } from '../src/infrastructure/persistence/sqlite';

afterEach(cleanupLegacyFlowState);

describe('startup repair leaves everything else untouched', () => {
  test('a child without a policy keeps its parent waiting (documented default)', async () => {
    const dataPath = tempDataPath();
    const [parent, child] = await writeChain(dataPath, 'no-policy', [null]);
    moveToDlqLikeOlderVersion(dataPath, child, FailureReason.MaxAttemptsExceeded, 'boom');

    const manager = open(dataPath);
    expect(await manager.getJobState(parent)).toBe('waiting-children');
    expect(flowFailureRows(dataPath)).toEqual([]);
    close(manager);
  });

  test('a discarded child (no terminal failure) keeps its parent waiting', async () => {
    const dataPath = tempDataPath();
    const [parent, child] = await writeChain(dataPath, 'discarded', ['failParentOnFailure']);
    moveToDlqLikeOlderVersion(dataPath, child, FailureReason.Unknown, null);

    const manager = open(dataPath);
    expect(await manager.getJobState(parent)).toBe('waiting-children');
    expect(flowFailureRows(dataPath)).toEqual([]);
    close(manager);
  });

  test('a child that is still retrying keeps its parent waiting', async () => {
    const dataPath = tempDataPath();
    const [parent, child] = await writeChain(dataPath, 'retrying', ['failParentOnFailure']);

    const manager = open(dataPath);
    expect(await manager.getJobState(parent)).toBe('waiting-children');
    expect(await manager.getJobState(child)).toBe('waiting');
    expect(flowFailureRows(dataPath)).toEqual([]);
    close(manager);
  });

  test('a parent that is itself in the DLQ is not touched', async () => {
    const dataPath = tempDataPath();
    const [parent, child] = await writeChain(dataPath, 'parent-dlq', ['failParentOnFailure']);
    moveToDlqLikeOlderVersion(dataPath, parent, FailureReason.Unknown, null);
    moveToDlqLikeOlderVersion(dataPath, child, FailureReason.MaxAttemptsExceeded, 'boom');

    const manager = open(dataPath);
    const [entry] = manager.getDlqEntries(QUEUE).filter((item) => item.job.id === parent);
    expect(entry.error).toBeNull();
    expect(flowFailureRows(dataPath)).toEqual([]);
    close(manager);
  });

  test('a parent already promoted out of waiting-children is not touched', async () => {
    const dataPath = tempDataPath();
    const [parent, child] = await writeChain(dataPath, 'promoted', ['failParentOnFailure']);
    moveToDlqLikeOlderVersion(dataPath, child, FailureReason.MaxAttemptsExceeded, 'boom');
    sql(dataPath, `UPDATE jobs SET state = 'waiting' WHERE id = ?`, String(parent));

    const manager = open(dataPath);
    expect(await manager.getJobState(parent)).toBe('waiting');
    expect(flowFailureRows(dataPath)).toEqual([]);
    close(manager);
  });

  test('a parent that ran after the child failed is not failed again', async () => {
    const dataPath = tempDataPath();
    const [parent, child] = await writeChain(dataPath, 'resumed', ['failParentOnFailure']);
    moveToDlqLikeOlderVersion(dataPath, child, FailureReason.MaxAttemptsExceeded, 'boom');
    const storage = new SqliteStorage({ path: dataPath });
    try {
      const job = storage.getJob(parent)!;
      job.timeline.push({ state: 'active', timestamp: Date.now() + 1_000 });
      job.timeline.push({ state: 'waiting-children', timestamp: Date.now() + 2_000 });
      storage.updateFlowParentResolution(job, 'waiting-children');
    } finally {
      storage.close();
    }

    const manager = open(dataPath);
    expect(await manager.getJobState(parent)).toBe('waiting-children');
    expect(flowFailureRows(dataPath)).toEqual([]);
    close(manager);
  });

  test('an existing record is applied as written, never replaced', async () => {
    const dataPath = tempDataPath();
    const [parent, child] = await writeChain(dataPath, 'existing', ['ignoreDependencyOnFailure']);
    moveToDlqLikeOlderVersion(dataPath, child, FailureReason.MaxAttemptsExceeded, 'from-dlq');
    const storage = new SqliteStorage({ path: dataPath });
    try {
      storage.saveFlowFailure({
        parentId: parent,
        childId: child,
        childQueue: QUEUE,
        mode: 'ignore',
        error: 'from-outbox',
        createdAt: Date.now(),
      });
    } finally {
      storage.close();
    }

    const manager = open(dataPath);
    expect(await manager.getIgnoredChildrenFailures(parent)).toEqual({
      [`${QUEUE}:${String(child)}`]: 'from-outbox',
    });
    expect(flowFailureRows(dataPath)).toHaveLength(1);
    close(manager);
  });
});
