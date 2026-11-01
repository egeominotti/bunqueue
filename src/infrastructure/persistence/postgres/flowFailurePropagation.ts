import type { TransactionSQL } from 'bun';
import type { JobId } from '../../../domain/types/job';
import { decodePostgresJob } from './codec';
import { databaseNow, runPostgresPostCommitMaintenance, type PostgresContext } from './context';
import { enforcePostgresDlqLimit } from './dlqLifecycle';
import {
  applyPostgresFlowFailure,
  lockPostgresJobFlowParent,
  postgresFlowFailureMode,
  type PostgresDlqLimitRequest,
  type PostgresFlowFailurePropagation,
} from './flowFailures';
import { storageLog } from '../../../shared/logger';
import { runPostgresTransactionWithRetry } from './transactionRetry';
import type { PostgresJobRow } from './types';

/**
 * Recursive flow-failure propagation for PostgreSQL.
 *
 * A parent that a child's `failParentOnFailure` moves to `failed` has failed terminally
 * itself, so its own policy applies to its parent. That level is not applied in the
 * transaction that failed the parent: it would need the next parent's locks while the
 * lower ones are held, against the canonical order. Instead the failing transaction
 * commits the parent's own record in `bunqueue_flow_failures` (the outbox), and each
 * level then runs in its own transaction, in the order of a terminal child failure:
 * dependency-completion lock of the child, flow lock of its parent, child row, parent
 * row. A record is pending while the parent's dependency edge on the child exists;
 * applying it removes the edge (or fails the parent), so a replay is a no-op. A crash
 * between two levels leaves the pending record for the recovery sweep of any broker.
 */

async function deleteRecord(
  tx: TransactionSQL,
  ctx: PostgresContext,
  item: PostgresFlowFailurePropagation
): Promise<void> {
  await tx`
    DELETE FROM bunqueue_flow_failures
    WHERE namespace = ${ctx.config.namespace}
      AND parent_id = ${String(item.parentId)} AND child_id = ${String(item.childId)}
  `;
}

/** Apply one pending record exactly once; returns the next level's DLQ request, if any. */
export async function applyPostgresFlowFailurePropagation(
  tx: TransactionSQL,
  ctx: PostgresContext,
  item: PostgresFlowFailurePropagation
): Promise<PostgresDlqLimitRequest | null> {
  // Same order as a worker FAIL of this child: every applier serializes here.
  await lockPostgresJobFlowParent(tx, ctx, item.childId);
  const [row] = await tx<PostgresJobRow[]>`
    SELECT * FROM bunqueue_jobs
    WHERE namespace = ${ctx.config.namespace} AND id = ${String(item.childId)}
    FOR UPDATE
  `;
  const [record] = await tx<Array<{ mode: string; error: string }>>`
    SELECT mode, error FROM bunqueue_flow_failures
    WHERE namespace = ${ctx.config.namespace}
      AND parent_id = ${String(item.parentId)} AND child_id = ${String(item.childId)}
  `;
  if (!record) return null;
  const [edge] = await tx<Array<{ found: number }>>`
    SELECT 1 AS found FROM bunqueue_dependencies
    WHERE namespace = ${ctx.config.namespace}
      AND job_id = ${String(item.parentId)} AND dependency_id = ${String(item.childId)}
  `;
  const child = row ? decodePostgresJob(row).job : null;
  const applicable =
    child !== null &&
    row?.state === 'failed' &&
    row.parent_id === String(item.parentId) &&
    String(child.parentId) === String(item.parentId) &&
    postgresFlowFailureMode(child) !== null;
  if (!edge) {
    // An applied ignore/continue record is the stored failure value. A record whose
    // parent failed or is gone was never applied (a parent's failure removes the values
    // really applied to it): drop it, like fail/remove records and stale children.
    const [parent] = await tx<Array<{ state: string }>>`
      SELECT state FROM bunqueue_jobs
      WHERE namespace = ${ctx.config.namespace} AND id = ${String(item.parentId)}
    `;
    const orphaned = !parent || parent.state === 'failed';
    if (!applicable || orphaned || record.mode === 'fail' || record.mode === 'remove') {
      await deleteRecord(tx, ctx, item);
    }
    return null;
  }
  await deleteRecord(tx, ctx, item);
  if (!applicable) return null;
  const now = await databaseNow(tx);
  return await applyPostgresFlowFailure(tx, ctx, child, record.error, now);
}

async function drain(ctx: PostgresContext, pending: PostgresFlowFailurePropagation[]) {
  const visited = new Set<string>();
  while (pending.length > 0) {
    const item = pending[0];
    const key = `${String(item.parentId)}\u0000${String(item.childId)}`;
    if (!visited.has(key)) {
      const request = await runPostgresTransactionWithRetry(ctx, (tx) =>
        applyPostgresFlowFailurePropagation(tx, ctx, item)
      );
      visited.add(key);
      if (request?.propagation) pending.push(request.propagation);
      if (request) {
        await runPostgresPostCommitMaintenance(ctx, `dlq-limit:${request.queue}`, () =>
          enforcePostgresDlqLimit(ctx, request.queue, request.maxEntries)
        );
      }
    }
    // Only a committed level leaves the list, so a retried drain resumes where it stopped.
    pending.shift();
  }
}

/** Apply records committed by a terminal transition, level by level, after its commit. */
export async function propagatePostgresFlowFailures(
  ctx: PostgresContext,
  seeds: readonly (PostgresFlowFailurePropagation | null | undefined)[]
): Promise<void> {
  for (const seed of seeds) {
    if (!seed) continue;
    const pending = [seed];
    await runPostgresPostCommitMaintenance(
      ctx,
      `flow-failure:${String(seed.parentId)}:${String(seed.childId)}`,
      () => drain(ctx, pending)
    );
  }
}

interface SweepRow {
  readonly parent_id: string;
  readonly child_id: string;
  readonly created_at: number | string | bigint;
}

/** One keyset page of records to finish: pending (edge present) or orphaned. */
async function sweepPage(
  ctx: PostgresContext,
  after: SweepRow | null,
  limit: number
): Promise<SweepRow[]> {
  const ns = ctx.config.namespace;
  const createdAt = after ? Number(after.created_at) : -1;
  const parentId = after?.parent_id ?? '';
  const childId = after?.child_id ?? '';
  return await ctx.sql<SweepRow[]>`
    SELECT failure.parent_id, failure.child_id, failure.created_at
    FROM bunqueue_flow_failures AS failure
    WHERE failure.namespace = ${ns}
      AND (failure.created_at, failure.parent_id, failure.child_id)
        > (${createdAt}::bigint, ${parentId}::text, ${childId}::text)
      AND (
        EXISTS (
          SELECT 1 FROM bunqueue_dependencies AS dependency
          WHERE dependency.namespace = failure.namespace
            AND dependency.job_id = failure.parent_id
            AND dependency.dependency_id = failure.child_id
        )
        OR NOT EXISTS (
          SELECT 1 FROM bunqueue_jobs AS parent
          WHERE parent.namespace = failure.namespace AND parent.id = failure.parent_id
            AND parent.state <> 'failed'
        )
      )
    ORDER BY failure.created_at, failure.parent_id, failure.child_id
    LIMIT ${limit}
  `;
}

function describeFailure(row: SweepRow, error: unknown): string {
  const cause = error instanceof Error ? error.message : String(error);
  return `parent ${row.parent_id} <- child ${row.child_id}: ${cause}`;
}

/**
 * Finish records a crashed or interrupted broker left between two levels, and drop
 * records orphaned by a parent that failed or vanished first. Pages through every
 * candidate with a keyset, each record on its own, so records that keep failing
 * cannot starve newer ones; the failures are logged and reported together.
 */
export async function recoverPostgresFlowFailurePropagations(
  ctx: PostgresContext,
  pageSize = 100
): Promise<number> {
  const limit = Math.max(1, pageSize);
  const failures: Array<{ row: SweepRow; error: unknown }> = [];
  let visited = 0;
  let after: SweepRow | null = null;
  for (;;) {
    const rows = await sweepPage(ctx, after, limit);
    for (const row of rows) {
      const item = { parentId: row.parent_id as JobId, childId: row.child_id as JobId };
      await drain(ctx, [item]).catch((error: unknown) => failures.push({ row, error }));
    }
    visited += rows.length;
    if (rows.length < limit) break;
    after = rows[rows.length - 1];
  }
  if (failures.length > 0) {
    const first = describeFailure(failures[0].row, failures[0].error);
    storageLog.warn('PostgreSQL flow failure propagation failed', {
      failed: failures.length,
      first,
    });
    throw new AggregateError(
      failures.map(({ error }) => error),
      `PostgreSQL flow failure propagation failed for ${failures.length} record(s); first ${first}`
    );
  }
  return visited;
}
