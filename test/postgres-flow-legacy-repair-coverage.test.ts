/**
 * PostgreSQL legacy flow-parent repair: coverage and steady state. Each broker process
 * makes one full pass over `bunqueue_dependencies` (first slice at startup, the rest on
 * the repair cadence), so an edge far past the first 1,000 is reached within seconds
 * instead of waiting for lease-recovery ticks, and a restart starts a new full pass.
 * After a clean pass the broker stops scanning. A parent that the current version
 * failed, that was retried from the DLQ and given a new child, is never failed again.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { FailureReason } from '../src/domain/types/dlq';
import type { JobId } from '../src/domain/types/job';
import { postgresFlowFailureRepairDone } from '../src/infrastructure/persistence/postgres/flowFailureRepair';
import { failPostgresJob } from '../src/infrastructure/persistence/postgres/outcomes';
import { updatePostgresJobParent } from '../src/infrastructure/persistence/postgres/relationships';
import { eventually, postgresManagerStore } from './support/postgres-event-race';
import {
  chain,
  cleanupLegacyNamespaces,
  ERROR,
  failLikeOlderVersion,
  postgresUrl,
  QUEUE,
  records,
  restart,
  start,
  state,
  stop,
  stopWriter,
  type Fixture,
} from './support/postgres-legacy-flow-state';

afterAll(cleanupLegacyNamespaces);

/** Edges that sort before every UUID job id and match no job: never candidates. */
async function insertFillerEdges(fixture: Fixture, count: number): Promise<void> {
  await fixture.sql`
    INSERT INTO bunqueue_dependencies (namespace, job_id, dependency_id)
    SELECT ${fixture.namespace}, '000-filler-' || lpad(g::text, 6, '0'), 'missing'
    FROM generate_series(1, ${count}::int) AS g
  `;
}

function repairDone(fixture: Fixture): boolean {
  return postgresFlowFailureRepairDone(postgresManagerStore(fixture.manager!).context);
}

describe('PostgreSQL legacy flow repair: coverage and steady state', () => {
  test.skipIf(!postgresUrl)(
    'an edge past the startup slice is repaired by the background pass, once',
    async () => {
      const fixture = await start('tail');
      try {
        const [parent, child] = await chain(fixture, ['failParentOnFailure']);
        await stopWriter(fixture);
        await insertFillerEdges(fixture, 2_500);
        await failLikeOlderVersion(fixture, child, FailureReason.MaxAttemptsExceeded, ERROR);

        await restart(fixture, 'tail-1');
        // The startup slice reads the first 1,000 edges; the pass continues on its own.
        expect(
          await eventually(async () => (await state(fixture, parent)).state === 'failed', 10_000)
        ).toBe(true);
        expect(await eventually(() => repairDone(fixture), 10_000)).toBe(true);
      } finally {
        await stop(fixture);
      }
    },
    30_000
  );

  test.skipIf(!postgresUrl)(
    'after a clean pass a broker stops scanning; a restart scans again',
    async () => {
      const fixture = await start('steady');
      try {
        const [parent, child] = await chain(fixture, ['removeDependencyOnFailure']);
        expect(await eventually(() => repairDone(fixture), 10_000)).toBe(true);

        // A stuck edge appearing now (an older broker in a rolling upgrade) waits for
        // the next broker start.
        await failLikeOlderVersion(fixture, child, FailureReason.MaxAttemptsExceeded, ERROR);
        await Bun.sleep(1_000);
        expect((await state(fixture, parent)).state).toBe('waiting-children');
        await stopWriter(fixture);

        await restart(fixture, 'steady-1');
        expect((await state(fixture, parent)).state).toBe('delayed');
      } finally {
        await stop(fixture);
      }
    },
    30_000
  );

  test.skipIf(!postgresUrl)(
    'a parent failed by its child, retried from the DLQ and given a new child keeps waiting',
    async () => {
      const fixture = await start('retry-link');
      try {
        const manager = fixture.manager!;
        const [parent] = await chain(fixture, []);
        const child = await manager.push(QUEUE, {
          data: { name: 'child' },
          failParentOnFailure: true,
          maxAttempts: 1,
        });
        await updatePostgresJobParent(fixture.ctx, child.id, parent);
        const claim = await manager.pullWithLock(QUEUE, 'retry-link-worker');
        expect(claim.job?.id).toBe(child.id);
        const failed = await failPostgresJob(fixture.ctx, {
          id: child.id,
          token: claim.token!,
          error: 'boom',
          unrecoverable: true,
        });
        expect(failed.applied).toBe(true);
        expect((await state(fixture, parent)).state).toBe('failed');
        expect(await manager.retryDlqDurable(QUEUE, parent)).toBe(1);
        const next = await manager.push(QUEUE, { data: { name: 'next' }, delay: 600_000 });
        await updatePostgresJobParent(fixture.ctx, next.id, parent as JobId);
        expect((await state(fixture, parent)).state).toBe('waiting-children');
        await stopWriter(fixture);

        await restart(fixture, 'retry-link-1');
        expect((await state(fixture, parent)).state).toBe('waiting-children');
        expect(await records(fixture)).toEqual([]);
      } finally {
        await stop(fixture);
      }
    },
    30_000
  );
});
