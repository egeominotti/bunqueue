import type { JobId } from '../../../domain/types/job';
import { storageLog } from '../../../shared/logger';
import type { PostgresContext } from './context';
import {
  POSTGRES_FLOW_FAILURE_SWEEP_PAGE,
  POSTGRES_FLOW_FAILURE_SWEEP_PAGES,
  propagatePostgresFlowFailures,
  recoverPostgresFlowFailurePropagations,
} from './flowFailurePropagation';
import { edgePage, type EdgeKey, prefilter, repairEdge } from './flowFailureRepairEdges';
import { runPostgresTransactionWithRetry } from './transactionRetry';

/**
 * PostgreSQL repair of flow parents that older versions left in `waiting-children`
 * (detection and per-edge repair: flowFailureRepairEdges.ts). Each broker process
 * makes one full pass over `bunqueue_dependencies` in primary-key order, from the first
 * edge to the last, in bounded slices: the first slice runs at startup before the
 * broker is ready, the rest on the `flowFailureRepair` maintenance cadence. A pass that
 * ends without an error completes the repair for this process: later slices do no
 * work, because a stuck parent can only come from an older version, and those that
 * older brokers create during a rolling upgrade are covered by the startup pass of the
 * newer broker that replaces them. A pass with errors starts over after
 * `POSTGRES_FLOW_FAILURE_REPAIR_RETRY_MS`. A written record is pending (its edge
 * exists) and is applied by the regular propagation applier exactly once across
 * brokers; a crash before that leaves it to the recovery sweep.
 */

/** Wait before a new pass when the previous one reported errors. */
export const POSTGRES_FLOW_FAILURE_REPAIR_RETRY_MS = 60_000;

interface RepairPass {
  /** The last edge read by this pass; null at the start of a pass. */
  after: EdgeKey | null;
  /** No edge failed in this pass so far. */
  clean: boolean;
  /** A clean pass reached the last edge: nothing is left to repair in this process. */
  done: boolean;
  /** No slice runs before this time (after a pass with errors). */
  retryAt: number;
}

/** One pass per broker context (process); a restarted broker starts a new pass. */
const passes = new WeakMap<PostgresContext, RepairPass>();

function passOf(ctx: PostgresContext): RepairPass {
  let pass = passes.get(ctx);
  if (!pass) {
    pass = { after: null, clean: true, done: false, retryAt: 0 };
    passes.set(ctx, pass);
  }
  return pass;
}

/** Whether this broker context completed a clean full pass. */
export function postgresFlowFailureRepairDone(ctx: PostgresContext): boolean {
  return passOf(ctx).done;
}

/** Repair one candidate edge; errors are collected so the others still run. */
async function repairOne(ctx: PostgresContext, edge: EdgeKey): Promise<boolean> {
  if (!(await runPostgresTransactionWithRetry(ctx, (tx) => repairEdge(tx, ctx, edge)))) {
    return false;
  }
  storageLog.warn('Repaired a flow parent left waiting by a terminally failed child', {
    parentId: edge.parent_id,
    childId: edge.child_id,
  });
  // A failure here leaves the record pending for the recovery sweep.
  const item = { parentId: edge.parent_id as JobId, childId: edge.child_id as JobId };
  await propagatePostgresFlowFailures(ctx, [item]);
  return true;
}

/**
 * One slice of this broker's pass: at most `maxPages` pages of `pageSize` edges,
 * continuing after the last edge the previous slice read. Returns the number of
 * records this broker wrote; a completed pass (or one waiting to retry) returns 0
 * without reading anything.
 */
export async function repairPostgresMissingFlowFailures(
  ctx: PostgresContext,
  pageSize = POSTGRES_FLOW_FAILURE_SWEEP_PAGE,
  maxPages = POSTGRES_FLOW_FAILURE_SWEEP_PAGES
): Promise<number> {
  const pass = passOf(ctx);
  if (pass.done || Date.now() < pass.retryAt) return 0;
  const limit = Math.max(1, pageSize);
  let repaired = 0;
  const failures: Array<{ edge: EdgeKey; error: unknown }> = [];
  for (let page = 0; page < Math.max(1, maxPages); page++) {
    const rows = await edgePage(ctx, pass.after, limit);
    for (const edge of await prefilter(
      ctx,
      rows.filter((row) => row.candidate)
    )) {
      // Each edge on its own: one that keeps failing cannot starve the others.
      try {
        if (await repairOne(ctx, edge)) repaired++;
      } catch (error: unknown) {
        failures.push({ edge, error });
      }
    }
    if (failures.length > 0) pass.clean = false;
    if (rows.length === limit) {
      const last = rows[rows.length - 1];
      pass.after = { parent_id: last.parent_id, child_id: last.child_id };
      continue;
    }
    // The last edge was read: the pass is over.
    if (pass.clean) pass.done = true;
    else pass.retryAt = Date.now() + POSTGRES_FLOW_FAILURE_REPAIR_RETRY_MS;
    pass.after = null;
    pass.clean = true;
    break;
  }
  if (failures.length > 0) {
    const [{ edge, error }] = failures;
    const first = `parent ${edge.parent_id} <- child ${edge.child_id}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    storageLog.warn('PostgreSQL flow failure repair failed', { failed: failures.length, first });
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `PostgreSQL flow failure repair failed for ${failures.length} edge(s); first ${first}`
    );
  }
  return repaired;
}

/**
 * The flow-failure maintenance of one run. `startup`: the first repair slice, then the
 * recovery sweep (finish or drop pending records); a failed repair does not skip the
 * sweep. `tick` (every lease-recovery tick): the sweep only. `repair` (the repair
 * cadence): the next repair slice only.
 */
export async function recoverPostgresFlowFailures(
  ctx: PostgresContext,
  phase: 'startup' | 'tick' | 'repair' = 'startup'
): Promise<void> {
  if (phase === 'repair') {
    await repairPostgresMissingFlowFailures(ctx);
    return;
  }
  if (phase === 'tick') {
    await recoverPostgresFlowFailurePropagations(ctx);
    return;
  }
  let repairError: unknown = null;
  await repairPostgresMissingFlowFailures(ctx).catch((error: unknown) => {
    repairError = error ?? new Error('PostgreSQL flow failure repair failed');
  });
  await recoverPostgresFlowFailurePropagations(ctx);
  if (repairError !== null) throw repairError;
}
