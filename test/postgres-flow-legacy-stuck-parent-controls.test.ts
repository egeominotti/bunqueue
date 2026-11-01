/**
 * PostgreSQL startup repair of flow parents left stuck by older versions: what it must
 * not touch, exactly-once across concurrent brokers, and the bounded paged scan. State
 * is written as in postgres-flow-legacy-stuck-parent-repair.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { FailureReason } from '../src/domain/types/dlq';
import type { JobId } from '../src/domain/types/job';
import {
  decodePostgresJob,
  encodePostgresValue,
} from '../src/infrastructure/persistence/postgres/codec';
import {
  recoverPostgresFlowFailures,
  repairPostgresMissingFlowFailures,
} from '../src/infrastructure/persistence/postgres/flowFailureRepair';
import type { PostgresJobRow } from '../src/infrastructure/persistence/postgres/types';
import {
  chain,
  cleanupLegacyNamespaces,
  ERROR,
  expectResolved,
  failLikeOlderVersion,
  postgresUrl,
  records,
  restart,
  start,
  state,
  stop,
  stopWriter,
} from './support/postgres-legacy-flow-state';

afterAll(cleanupLegacyNamespaces);

describe('PostgreSQL legacy flow repair: controls, races and paging', () => {
  test.skipIf(!postgresUrl)(
    'controls: no policy, a discard, a retrying child and parents not waiting are untouched',
    async () => {
      const fixture = await start('controls');
      try {
        const [noPolicyParent, noPolicyChild] = await chain(fixture, [null]);
        const [discardParent, discardChild] = await chain(fixture, ['failParentOnFailure']);
        const [retryParent, retryChild] = await chain(fixture, ['failParentOnFailure']);
        const [failedParent, failedParentChild] = await chain(fixture, ['failParentOnFailure']);
        const [resumedParent, resumedChild] = await chain(fixture, ['failParentOnFailure']);
        await stopWriter(fixture);
        await failLikeOlderVersion(
          fixture,
          noPolicyChild,
          FailureReason.MaxAttemptsExceeded,
          ERROR
        );
        await failLikeOlderVersion(fixture, discardChild, FailureReason.Unknown, null);
        await failLikeOlderVersion(fixture, failedParent, FailureReason.Unknown, null);
        await failLikeOlderVersion(
          fixture,
          failedParentChild,
          FailureReason.MaxAttemptsExceeded,
          ERROR
        );
        await failLikeOlderVersion(fixture, resumedChild, FailureReason.MaxAttemptsExceeded, ERROR);
        // The parent ran after its child failed (released by someone), then waited again.
        const [row] = await fixture.sql<PostgresJobRow[]>`
          SELECT * FROM bunqueue_jobs
          WHERE namespace = ${fixture.namespace} AND id = ${String(resumedParent)}
        `;
        const resumed = decodePostgresJob(row).job;
        resumed.timeline.push({ state: 'active', timestamp: Date.now() + 1_000 });
        await fixture.sql`
          UPDATE bunqueue_jobs SET payload = ${encodePostgresValue(resumed)}
          WHERE namespace = ${fixture.namespace} AND id = ${String(resumedParent)}
        `;

        await restart(fixture, 'controls-1');
        for (const parent of [noPolicyParent, discardParent, retryParent, resumedParent]) {
          expect((await state(fixture, parent)).state).toBe('waiting-children');
        }
        expect(await state(fixture, failedParent)).toEqual({ state: 'failed', error: null });
        expect((await state(fixture, retryChild)).state).toBe('delayed');
        expect(await records(fixture)).toEqual([]);
        expect(await repairPostgresMissingFlowFailures(fixture.ctx)).toBe(0);
      } finally {
        await stop(fixture);
      }
    },
    30_000
  );

  for (const policy of ['failParentOnFailure', 'ignoreDependencyOnFailure'] as const) {
    test.skipIf(!postgresUrl)(
      `concurrent brokers repair a ${policy} parent exactly once`,
      async () => {
        const fixture = await start(`race-${policy}`);
        const pools = Array.from({ length: 6 }, () => new SQL(postgresUrl!, { max: 2 }));
        try {
          const pairs: Array<[JobId, JobId]> = [];
          for (let index = 0; index < 4; index++) {
            const [parent, child] = await chain(fixture, [policy]);
            pairs.push([parent, child]);
          }
          await stopWriter(fixture);
          for (const [, child] of pairs) {
            await failLikeOlderVersion(fixture, child, FailureReason.Stalled, ERROR);
          }

          const written = await Promise.all(
            pools.map((pool) => repairPostgresMissingFlowFailures({ ...fixture.ctx, sql: pool }))
          );
          expect(written.reduce((sum, count) => sum + count, 0)).toBe(pairs.length);
          await Promise.all(
            pools.map((pool) => recoverPostgresFlowFailures({ ...fixture.ctx, sql: pool }))
          );

          await restart(fixture, `race-${policy}-1`);
          for (const [parent, child] of pairs) {
            await expectResolved(fixture, policy, parent, child, ERROR);
          }
        } finally {
          await Promise.allSettled(pools.map((pool) => pool.close({ timeout: 5 })));
          await stop(fixture);
        }
      },
      60_000
    );
  }

  test.skipIf(!postgresUrl)(
    'a bounded run continues where it stopped and reaches every edge',
    async () => {
      const fixture = await start('budget');
      try {
        const pairs: Array<[JobId, JobId]> = [];
        for (let index = 0; index < 3; index++) {
          pairs.push((await chain(fixture, ['removeDependencyOnFailure'])) as [JobId, JobId]);
        }
        const [noPolicyParent, noPolicyChild] = await chain(fixture, [null]);
        await stopWriter(fixture);
        for (const [, child] of pairs) {
          await failLikeOlderVersion(fixture, child, FailureReason.MaxAttemptsExceeded, ERROR);
        }
        await failLikeOlderVersion(
          fixture,
          noPolicyChild,
          FailureReason.MaxAttemptsExceeded,
          ERROR
        );

        // One edge per run: four edges, so four runs reach all three repairs.
        const ctx = { ...fixture.ctx };
        let total = 0;
        for (let run = 0; run < 4; run++) {
          total += await repairPostgresMissingFlowFailures(ctx, 1, 1);
        }
        expect(total).toBe(pairs.length);
        for (const [parent] of pairs) expect((await state(fixture, parent)).state).toBe('delayed');
        expect((await state(fixture, noPolicyParent)).state).toBe('waiting-children');
        expect(await repairPostgresMissingFlowFailures(ctx, 1, 10)).toBe(0);
      } finally {
        await stop(fixture);
      }
    },
    30_000
  );
});
