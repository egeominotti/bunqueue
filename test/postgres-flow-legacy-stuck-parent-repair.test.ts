/**
 * PostgreSQL startup repair of flow parents that older versions left in
 * `waiting-children`: a parent with a dependency edge on a `failed` child carrying a
 * failure policy and no `bunqueue_flow_failures` record. Older versions failed a parent
 * by a child's `failParentOnFailure` without writing the parent's own record toward its
 * parent (fixed in abf68947); any terminal move that skipped the policy leaves the same
 * shape. The state is written with SQL exactly as those versions committed it, then a
 * broker starts on it. Repairs must apply once across brokers and never touch a child
 * without a policy, a discarded child, a child still retrying or a parent not waiting
 * (postgres-flow-legacy-stuck-parent-controls.test.ts).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { FailureReason } from '../src/domain/types/dlq';
import { repairPostgresMissingFlowFailures } from '../src/infrastructure/persistence/postgres/flowFailureRepair';
import {
  chain,
  cleanupLegacyNamespaces,
  ERROR,
  expectResolved,
  failLikeOlderVersion,
  POLICIES,
  postgresUrl,
  records,
  restart,
  start,
  state,
  stop,
  stopWriter,
} from './support/postgres-legacy-flow-state';

afterAll(cleanupLegacyNamespaces);

describe('PostgreSQL startup repair of legacy stuck flow parents', () => {
  for (const policy of POLICIES) {
    test.skipIf(!postgresUrl)(
      `terminal child with ${policy}: the parent is resolved once, across restarts`,
      async () => {
        const fixture = await start(`a-${policy}`);
        try {
          const [parent, child] = await chain(fixture, [policy]);
          await stopWriter(fixture);
          await failLikeOlderVersion(fixture, child, FailureReason.MaxAttemptsExceeded, ERROR);
          expect(await records(fixture)).toEqual([]);
          expect((await state(fixture, parent)).state).toBe('waiting-children');

          await restart(fixture, `a-${policy}-1`);
          await expectResolved(fixture, policy, parent, child, ERROR);
          const after = await records(fixture);
          await fixture.manager!.shutdownPostgres();

          await restart(fixture, `a-${policy}-2`);
          await expectResolved(fixture, policy, parent, child, ERROR);
          expect(await records(fixture)).toEqual(after);
          expect(await repairPostgresMissingFlowFailures(fixture.ctx)).toBe(0);
        } finally {
          await stop(fixture);
        }
      },
      30_000
    );

    test.skipIf(!postgresUrl)(
      `failed middle node with ${policy}: the grandparent is resolved`,
      async () => {
        const fixture = await start(`b-${policy}`);
        try {
          const [grandparent, mid, leaf] = await chain(fixture, [policy, 'failParentOnFailure']);
          await stopWriter(fixture);
          await failLikeOlderVersion(fixture, leaf, FailureReason.ExplicitFail, 'boom');
          const midError = `Child job ${String(leaf)} failed: boom`;
          await failLikeOlderVersion(fixture, mid, FailureReason.Unknown, midError, {
            dropOwnEdges: true,
          });

          await restart(fixture, `b-${policy}-1`);
          await expectResolved(fixture, policy, grandparent, mid, midError);
          // The leaf's edge was consumed with its parent's failure: nothing else changed.
          expect((await state(fixture, mid)).error).toBe(midError);
        } finally {
          await stop(fixture);
        }
      },
      30_000
    );
  }
});
