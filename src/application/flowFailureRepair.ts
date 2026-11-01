/**
 * SQLite startup repair of flow parents that older versions left in `waiting-children`
 * (see domain/job/flowFailureRepair.ts for the rule). It runs inside the flow-failure
 * outbox replay, after recovery restored the pending jobs and the DLQ, and only writes
 * the missing outbox records: the replay applies them like any other record, so the
 * repair is durable (a crash before the replay finishes leaves the records) and
 * idempotent (an applied record removed the edge or failed the parent).
 */

import type { DlqEntry } from '../domain/types/dlq';
import type { FlowFailureRecord } from '../domain/types/flow';
import type { JobId } from '../domain/types/job';
import { missingFlowFailureRecord } from '../domain/job/flowFailureRepair';
import { shardIndex } from '../shared/hash';
import { queueLog } from '../shared/logger';
import type { FlowFailureRecoveryContext } from './flowFailureRecovery';

/** The repaired parent/child pairs named in the startup log (the count is always logged). */
const LOGGED_PAIRS = 20;

function recordKey(parentId: JobId, childId: JobId): string {
  return `${String(parentId)}\u0000${String(childId)}`;
}

/** The newest DLQ entry per job of one queue, built once per queue that needs it. */
function dlqEntryOf(
  ctx: FlowFailureRecoveryContext,
  cache: Map<string, Map<JobId, DlqEntry>>,
  queue: string,
  id: JobId
): DlqEntry | undefined {
  let entries = cache.get(queue);
  if (!entries) {
    entries = new Map();
    // Entries are appended in DLQ order, so the last one per job wins.
    for (const entry of ctx.shards[shardIndex(queue)].getDlqEntries(queue)) {
      entries.set(entry.job.id, entry);
    }
    cache.set(queue, entries);
  }
  return entries.get(id);
}

/**
 * Write the outbox record an older version did not write for every waiting parent
 * whose dependency edge points at a terminally failed child carrying a policy.
 * Returns the number of records written; an existing record is never replaced. A write
 * error stops startup, as the replay's own writes do.
 */
export function repairMissingFlowFailures(
  ctx: FlowFailureRecoveryContext,
  existing: readonly FlowFailureRecord[]
): number {
  const known = new Set(existing.map((record) => recordKey(record.parentId, record.childId)));
  const cache = new Map<string, Map<JobId, DlqEntry>>();
  const repaired: FlowFailureRecord[] = [];
  for (const shard of ctx.shards) {
    // Recovery puts every parent persisted in `waiting-children` with unresolved
    // dependencies here; promoted, active and failed parents are never candidates.
    for (const parent of shard.waitingDeps.values()) {
      for (const dependencyId of parent.dependsOn) {
        const location = ctx.jobIndex.get(dependencyId);
        if (location?.type !== 'dlq') continue;
        const key = recordKey(parent.id, dependencyId);
        if (known.has(key)) continue;
        const entry = dlqEntryOf(ctx, cache, location.queueName, dependencyId);
        if (!entry) continue;
        const record = missingFlowFailureRecord(parent, {
          job: entry.job,
          reason: entry.reason,
          error: entry.error,
          failedAt: entry.attempts.at(-1)?.failedAt ?? entry.enteredAt,
        });
        if (!record) continue;
        known.add(key);
        repaired.push(record);
      }
    }
  }
  if (repaired.length === 0) return 0;
  ctx.storage.insertMissingFlowFailures(repaired);
  queueLog.warn('Repaired flow parents left waiting by a terminally failed child', {
    records: repaired.length,
    pairs: repaired
      .slice(0, LOGGED_PAIRS)
      .map((record) => `${String(record.parentId)} <- ${String(record.childId)} (${record.mode})`),
  });
  return repaired.length;
}
