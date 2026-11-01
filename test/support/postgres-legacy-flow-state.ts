/**
 * PostgreSQL flow state that older bunqueue versions left behind: a parent in
 * `waiting-children` with a dependency edge on a `failed` child that carries a failure
 * policy and has no `bunqueue_flow_failures` record. Shared by the PostgreSQL startup
 * repair tests.
 */
import { expect } from 'bun:test';
import { SQL } from 'bun';
import { PostgresQueueManager } from '../../src/application/postgresQueueManager';
import { createDlqEntry, FailureReason } from '../../src/domain/types/dlq';
import type { JobId, JobInput } from '../../src/domain/types/job';
import {
  decodePostgresJob,
  encodePostgresValue,
} from '../../src/infrastructure/persistence/postgres/codec';
import type { PostgresContext } from '../../src/infrastructure/persistence/postgres/context';
import { updatePostgresJobParent } from '../../src/infrastructure/persistence/postgres/relationships';
import type { PostgresJobRow } from '../../src/infrastructure/persistence/postgres/types';
import { cleanupPostgresNamespace, postgresRaceContext } from './postgres-event-race';

export const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespaces: string[] = [];

/** Delete every namespace the scenarios created. */
export async function cleanupLegacyNamespaces(): Promise<void> {
  if (!postgresUrl) return;
  for (const namespace of namespaces.splice(0)) {
    await cleanupPostgresNamespace(postgresUrl, namespace);
  }
}

export const ERROR = 'PostgreSQL lease expired';
export const QUEUE = 'flow-legacy-repair';

export type Policy =
  | 'failParentOnFailure'
  | 'ignoreDependencyOnFailure'
  | 'removeDependencyOnFailure'
  | 'continueParentOnFailure';

export const POLICIES: Policy[] = [
  'failParentOnFailure',
  'ignoreDependencyOnFailure',
  'removeDependencyOnFailure',
  'continueParentOnFailure',
];

export interface Fixture {
  readonly namespace: string;
  readonly sql: SQL;
  readonly ctx: PostgresContext;
  manager: PostgresQueueManager | null;
}

export function broker(namespace: string, brokerId: string): PostgresQueueManager {
  return new PostgresQueueManager({ postgres: { url: postgresUrl!, namespace, brokerId } });
}

export async function start(label: string): Promise<Fixture> {
  const namespace = `test-flow-legacy-${label}-${Date.now()}-${crypto.randomUUID()}`;
  namespaces.push(namespace);
  const manager = broker(namespace, `${label}-writer`);
  await manager.waitUntilReady();
  const sql = new SQL(postgresUrl!, { max: 4 });
  return { namespace, sql, ctx: postgresRaceContext(manager, sql), manager };
}

/** Stop the broker that wrote the flow: the stuck state is then written offline. */
export async function stopWriter(fixture: Fixture): Promise<void> {
  await fixture.manager?.shutdownPostgres();
  fixture.manager = null;
}

/** Start a broker on the stored state: its startup recovery runs before it is ready. */
export async function restart(fixture: Fixture, brokerId: string): Promise<PostgresQueueManager> {
  const manager = broker(fixture.namespace, brokerId);
  await manager.waitUntilReady();
  fixture.manager = manager;
  return manager;
}

export async function stop(fixture: Fixture): Promise<void> {
  await Promise.allSettled([
    fixture.manager?.shutdownPostgres(),
    fixture.sql.close({ timeout: 5 }),
  ]);
}

export async function push(fixture: Fixture, name: string, input: Partial<JobInput>) {
  return await fixture.manager!.push(QUEUE, { data: { name }, delay: 600_000, ...input });
}

/** `ids[0] <- ids[1] <- ...`; `policies[i]` belongs to node i + 1. */
export async function chain(fixture: Fixture, policies: Array<Policy | null>): Promise<JobId[]> {
  const ids = [(await push(fixture, 'root', {})).id];
  for (const [index, policy] of policies.entries()) {
    const job = await push(fixture, `node-${index + 1}`, {
      ...(policy ? { [policy]: true } : {}),
      maxAttempts: 1,
    });
    await updatePostgresJobParent(fixture.ctx, job.id, ids[ids.length - 1]);
    ids.push(job.id);
  }
  // A heartbeat in the same millisecond as the child's failure counts as "after" it.
  await Bun.sleep(2);
  return ids;
}

/** A terminal move as an older version committed it: the row only, no flow effect. */
export async function failLikeOlderVersion(
  fixture: Fixture,
  id: JobId,
  reason: FailureReason,
  error: string | null,
  options: { dropOwnEdges?: boolean } = {}
): Promise<void> {
  const [row] = await fixture.sql<PostgresJobRow[]>`
    SELECT * FROM bunqueue_jobs WHERE namespace = ${fixture.namespace} AND id = ${String(id)}
  `;
  const job = decodePostgresJob(row).job;
  const now = Date.now();
  job.attempts = job.maxAttempts;
  job.completedAt = now;
  const entry = createDlqEntry(job, reason, error, undefined, now);
  if (options.dropOwnEdges) {
    // A parent failed by a child also lost its own dependency edges.
    await fixture.sql`
      DELETE FROM bunqueue_dependencies
      WHERE namespace = ${fixture.namespace} AND job_id = ${String(id)}
    `;
  }
  await fixture.sql`
    UPDATE bunqueue_jobs
    SET payload = ${encodePostgresValue(job)}, state = 'failed', attempts = ${job.attempts},
        completed_at = ${now}, error = ${error}, failure_reason = ${reason},
        dlq_entry = ${encodePostgresValue(entry)}, dlq_retry_state = NULL,
        version = version + 1
    WHERE namespace = ${fixture.namespace} AND id = ${String(id)}
  `;
}

export async function state(
  fixture: Fixture,
  id: JobId
): Promise<{ state: string; error: string | null }> {
  const [found] = await fixture.sql<Array<{ state: string; error: string | null }>>`
    SELECT state, error FROM bunqueue_jobs
    WHERE namespace = ${fixture.namespace} AND id = ${String(id)}
  `;
  return found;
}

export async function events(fixture: Fixture, id: JobId, type: string): Promise<number> {
  const [found] = await fixture.sql<Array<{ count: number | string | bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM bunqueue_events
    WHERE namespace = ${fixture.namespace} AND job_id = ${String(id)} AND event_type = ${type}
  `;
  return Number(found.count);
}

export async function records(fixture: Fixture) {
  return await fixture.sql<Array<{ parent_id: string; child_id: string; mode: string }>>`
    SELECT parent_id, child_id, mode FROM bunqueue_flow_failures
    WHERE namespace = ${fixture.namespace} ORDER BY parent_id, child_id
  `;
}

export async function expectResolved(
  fixture: Fixture,
  policy: Policy,
  parent: JobId,
  child: JobId,
  error: string
): Promise<void> {
  const manager = fixture.manager!;
  const parentRow = await state(fixture, parent);
  const key = `${QUEUE}:${String(child)}`;
  if (policy === 'failParentOnFailure') {
    expect(parentRow).toEqual({
      state: 'failed',
      error: `Child job ${String(child)} failed: ${error}`,
    });
    expect(await events(fixture, parent, 'failed')).toBe(1);
    return;
  }
  // The pushed parent is delayed: once released it returns to `delayed`.
  expect(parentRow.state).toBe('delayed');
  expect(await events(fixture, parent, 'retried')).toBe(1);
  const ignored = await manager.getIgnoredChildrenFailures(parent);
  const failed = await manager.getFailedChildrenValues(parent);
  expect(ignored).toEqual(policy === 'ignoreDependencyOnFailure' ? { [key]: error } : {});
  expect(failed).toEqual(policy === 'continueParentOnFailure' ? { [key]: error } : {});
}
