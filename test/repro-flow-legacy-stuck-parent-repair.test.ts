/**
 * Startup repair of flow parents that older versions left in `waiting-children`.
 *
 * Before 120ccbe3 a flow child carrying a failure policy that startup recovery, lock
 * expiry or stall detection exhausted went to the DLQ without its `flow_failures`
 * outbox record; before f021b8c4 a parent failed by a child's `failParentOnFailure`
 * never wrote its own record toward its parent. Either way the parent kept its
 * dependency edge on a terminally failed child and waited forever. These tests write
 * exactly that persisted state through the storage API (the DLQ entry plus the row
 * delete an older version committed, and no outbox record), then start a broker on it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { FailureReason } from '../src/domain/types/dlq';
import {
  cleanupLegacyFlowState,
  close,
  expectResolved,
  flowFailureRows,
  moveToDlqLikeOlderVersion,
  open,
  POLICIES,
  RECOVERY_ERROR,
  tempDataPath,
  writeChain,
} from './support/legacy-flow-state';

afterEach(cleanupLegacyFlowState);

describe('startup repair: a terminal child an older version left without its record', () => {
  for (const policy of POLICIES) {
    test(`${policy}: the waiting parent is resolved, once`, async () => {
      const dataPath = tempDataPath();
      const [parent, child] = await writeChain(dataPath, `a-${policy}`, [policy]);
      moveToDlqLikeOlderVersion(dataPath, child, FailureReason.MaxAttemptsExceeded, RECOVERY_ERROR);
      expect(flowFailureRows(dataPath)).toEqual([]);

      const first = open(dataPath);
      await expectResolved(first, policy, parent, child, RECOVERY_ERROR);
      expect(await first.getJobState(child)).toBe('failed');
      const records = flowFailureRows(dataPath);
      close(first);

      // Idempotent: a second start finds nothing to repair and changes nothing.
      const second = open(dataPath);
      await expectResolved(second, policy, parent, child, RECOVERY_ERROR);
      expect(flowFailureRows(dataPath)).toEqual(records);
      close(second);
    });
  }
});

describe('startup repair: a failed parent an older version left without its own record', () => {
  for (const policy of POLICIES) {
    test(`middle node with ${policy}: the grandparent is resolved`, async () => {
      const dataPath = tempDataPath();
      const [grandparent, mid, leaf] = await writeChain(dataPath, `b-${policy}`, [
        policy,
        'failParentOnFailure',
      ]);
      moveToDlqLikeOlderVersion(dataPath, leaf, FailureReason.ExplicitFail, 'boom');
      const midError = `Child job ${String(leaf)} failed: boom`;
      moveToDlqLikeOlderVersion(dataPath, mid, FailureReason.Unknown, midError);

      const manager = open(dataPath);
      expect(await manager.getJobState(mid)).toBe('failed');
      await expectResolved(manager, policy, grandparent, mid, midError);
      close(manager);
    });
  }

  test('a repaired fail record climbs the tree like any outbox record', async () => {
    const dataPath = tempDataPath();
    const [grandparent, mid, leaf] = await writeChain(dataPath, 'climb', [
      'ignoreDependencyOnFailure',
      'failParentOnFailure',
    ]);
    moveToDlqLikeOlderVersion(dataPath, leaf, FailureReason.Stalled, 'Job stalled 3 times');

    const manager = open(dataPath);
    const midError = `Child job ${String(leaf)} failed: Job stalled 3 times`;
    expect(await manager.getJobState(mid)).toBe('failed');
    await expectResolved(manager, 'ignoreDependencyOnFailure', grandparent, mid, midError);
    close(manager);
  });
});
