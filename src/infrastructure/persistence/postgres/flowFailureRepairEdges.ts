import type { TransactionSQL } from 'bun';
import type { FlowFailureRecord } from '../../../domain/types/flow';
import type { JobId } from '../../../domain/types/job';
import { FAILED_BY_CHILD_PREFIX } from '../../../domain/job/flowFailureMessage';
import { missingFlowFailureRecord } from '../../../domain/job/flowFailureRepair';
import { decodePostgresJob, numeric } from './codec';
import type { PostgresContext } from './context';
import { lockPostgresJobFlowParent } from './flowFailures';
import type { PostgresJobRow } from './types';

/**
 * Detection and per-edge repair for flow parents that older versions left in
 * `waiting-children` (rule: domain/job/flowFailureRepair.ts; the pass that drives it
 * is flowFailureRepair.ts). A page of `bunqueue_dependencies` read by primary key flags
 * each edge from a `waiting-children` parent to a `failed` child linked to it without a
 * `bunqueue_flow_failures` record; the rule then runs on the decoded rows without locks,
 * and each remaining match is re-checked under the locks of a terminal failure of that
 * child (dependency-completion lock of the child, flow lock of its parent, child row,
 * parent row) before its missing record is written.
 */

export interface EdgeKey {
  readonly parent_id: string;
  readonly child_id: string;
}

export interface EdgeRow extends EdgeKey {
  readonly candidate: boolean;
}

/** A page of edges in primary-key order, each flagged when it may need a repair. */
export async function edgePage(
  ctx: PostgresContext,
  after: EdgeKey | null,
  limit: number
): Promise<EdgeRow[]> {
  const ns = ctx.config.namespace;
  return await ctx.sql<EdgeRow[]>`
    WITH edge AS MATERIALIZED (
      SELECT job_id, dependency_id FROM bunqueue_dependencies
      WHERE namespace = ${ns}
        AND (job_id, dependency_id) > (${after?.parent_id ?? ''}::text, ${after?.child_id ?? ''}::text)
      ORDER BY job_id, dependency_id
      LIMIT ${limit}
    )
    SELECT edge.job_id AS parent_id, edge.dependency_id AS child_id,
      (parent.id IS NOT NULL AND child.id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM bunqueue_flow_failures AS failure
        WHERE failure.namespace = ${ns}
          AND failure.parent_id = edge.job_id AND failure.child_id = edge.dependency_id
      )) AS candidate
    FROM edge
    LEFT JOIN bunqueue_jobs AS parent
      ON parent.namespace = ${ns} AND parent.id = edge.job_id
        AND parent.state = 'waiting-children'
    LEFT JOIN bunqueue_jobs AS child
      ON child.namespace = ${ns} AND child.id = edge.dependency_id
        AND child.state = 'failed' AND child.parent_id = edge.job_id
        AND child.failure_reason IS NOT NULL
        AND (child.failure_reason <> 'unknown' OR child.error LIKE ${`${FAILED_BY_CHILD_PREFIX}%`})
    ORDER BY edge.job_id, edge.dependency_id
  `;
}

/** The record to write for this parent/child pair from their current rows, if any. */
function repairFor(parentRow: PostgresJobRow, childRow: PostgresJobRow): FlowFailureRecord | null {
  if (parentRow.state !== 'waiting-children' || childRow.state !== 'failed') return null;
  const child = decodePostgresJob(childRow);
  const failedAt =
    numeric(childRow.completed_at) ??
    child.dlqEntry?.attempts.at(-1)?.failedAt ??
    child.dlqEntry?.enteredAt ??
    0;
  return missingFlowFailureRecord(decodePostgresJob(parentRow).job, {
    job: child.job,
    reason: childRow.failure_reason,
    error: childRow.error,
    failedAt,
  });
}

async function lockedRow(tx: TransactionSQL, ctx: PostgresContext, id: string) {
  const [row] = await tx<PostgresJobRow[]>`
    SELECT * FROM bunqueue_jobs
    WHERE namespace = ${ctx.config.namespace} AND id = ${id}
    FOR UPDATE
  `;
  return row;
}

/** Re-check one edge under a terminal failure's locks and write its missing record. */
export async function repairEdge(tx: TransactionSQL, ctx: PostgresContext, edge: EdgeKey) {
  const ns = ctx.config.namespace;
  await lockPostgresJobFlowParent(tx, ctx, edge.child_id as JobId);
  const childRow = await lockedRow(tx, ctx, edge.child_id);
  if (!childRow || childRow.parent_id !== edge.parent_id) return false;
  const parentRow = await lockedRow(tx, ctx, edge.parent_id);
  if (!parentRow) return false;
  const [linked] = await tx<Array<{ found: number }>>`
    SELECT 1 AS found FROM bunqueue_dependencies
    WHERE namespace = ${ns} AND job_id = ${edge.parent_id} AND dependency_id = ${edge.child_id}
  `;
  const record = linked ? repairFor(parentRow, childRow) : null;
  if (!record) return false;
  const inserted = await tx`
    INSERT INTO bunqueue_flow_failures
      (namespace, parent_id, child_id, child_queue, mode, error, created_at)
    VALUES (${ns}, ${String(record.parentId)}, ${String(record.childId)}, ${record.childQueue},
            ${record.mode}, ${record.error}, ${record.createdAt})
    ON CONFLICT (namespace, parent_id, child_id) DO NOTHING
    RETURNING child_id
  `;
  return inserted.length > 0;
}

/** Candidate edges whose current rows still call for a repair (checked without locks). */
export async function prefilter(
  ctx: PostgresContext,
  edges: readonly EdgeKey[]
): Promise<EdgeKey[]> {
  if (edges.length === 0) return [];
  const ids = [...new Set(edges.flatMap((edge) => [edge.parent_id, edge.child_id]))];
  const rows = await ctx.sql<PostgresJobRow[]>`
    SELECT * FROM bunqueue_jobs
    WHERE namespace = ${ctx.config.namespace} AND id = ANY(${ctx.sql.array(ids, 'TEXT')})
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return edges.filter((edge) => {
    const parentRow = byId.get(edge.parent_id);
    const childRow = byId.get(edge.child_id);
    return parentRow && childRow ? repairFor(parentRow, childRow) !== null : false;
  });
}
