/**
 * Persisted flow state that older bunqueue versions left behind: a flow parent in
 * `waiting-children` whose dependency is a terminally failed child (in the DLQ) with a
 * failure policy and no `flow_failures` outbox record. Shared by the SQLite startup
 * repair tests.
 */
import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../../src/application/queueManager';
import { createDlqEntry, FailureReason } from '../../src/domain/types/dlq';
import { jobId, type JobId } from '../../src/domain/types/job';
import { SqliteStorage } from '../../src/infrastructure/persistence/sqlite';

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

export const QUEUE = 'legacy-stuck-parent';
export const RECOVERY_ERROR = 'Job reached max attempts (1) during startup recovery';
const directories: string[] = [];
const managers: QueueManager[] = [];

/** Shut down every broker the scenario left open and delete its databases. */
export function cleanupLegacyFlowState(): void {
  for (const manager of managers.splice(0)) {
    try {
      manager.shutdown();
    } catch {
      // Already shut down by the scenario.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function tempDataPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bunqueue-legacy-stuck-parent-'));
  directories.push(directory);
  return join(directory, 'queue.db');
}

export function open(dataPath: string): QueueManager {
  const manager = new QueueManager({ dataPath, stallCheckMs: 60_000 });
  managers.push(manager);
  return manager;
}

export function close(manager: QueueManager): void {
  managers.splice(managers.indexOf(manager), 1);
  manager.shutdown();
}

/** A linear chain root <- ... <- leaf; `policies[i]` belongs to node i + 1. */
export async function writeChain(
  dataPath: string,
  label: string,
  policies: Array<Policy | null>
): Promise<JobId[]> {
  const manager = open(dataPath);
  const ids = [jobId(`${label}-root`)];
  for (let index = 0; index < policies.length; index++) ids.push(jobId(`${label}-n${index + 1}`));
  for (let index = 0; index < ids.length; index++) {
    const childId = ids[index + 1];
    const parentId = ids[index - 1];
    const policy = index === 0 ? null : policies[index - 1];
    await manager.push(QUEUE, {
      ...(policy ? { [policy]: true } : {}),
      customId: String(ids[index]),
      data: parentId ? { __parentId: String(parentId), __parentQueue: QUEUE } : {},
      ...(childId ? { dependsOn: [childId], childrenIds: [childId] } : {}),
      ...(parentId ? { parentId } : {}),
      durable: true,
      maxAttempts: 1,
    });
  }
  close(manager);
  return ids;
}

/**
 * What an older version committed when it moved a job to the DLQ without the policy:
 * the DLQ entry, then the job rows (`saveDlqEntry` + `deleteJob`), and nothing else.
 */
export function moveToDlqLikeOlderVersion(
  dataPath: string,
  id: JobId,
  reason: FailureReason,
  error: string | null
): void {
  const storage = new SqliteStorage({ path: dataPath });
  try {
    const job = storage.getJob(id);
    if (!job) throw new Error(`missing job ${String(id)}`);
    job.attempts = job.maxAttempts;
    storage.saveDlqEntry(createDlqEntry(job, reason, error));
    storage.deleteJob(id);
  } finally {
    storage.close();
  }
}

export function sql<T>(dataPath: string, query: string, ...params: string[]): T[] {
  const db = new Database(dataPath);
  try {
    return db.query(query).all(...params) as T[];
  } finally {
    db.close();
  }
}

export function flowFailureRows(dataPath: string) {
  return sql<{ parent_id: string; child_id: string; mode: string; error: string }>(
    dataPath,
    'SELECT parent_id, child_id, mode, error FROM flow_failures ORDER BY parent_id, child_id'
  );
}

export async function expectResolved(
  manager: QueueManager,
  policy: Policy,
  parentId: JobId,
  childId: JobId,
  error: string
): Promise<void> {
  const state = await manager.getJobState(parentId);
  const key = `${QUEUE}:${String(childId)}`;
  if (policy === 'failParentOnFailure') {
    expect(state).toBe('failed');
    const [entry] = manager.getDlqEntries(QUEUE).filter((item) => item.job.id === parentId);
    expect(entry.error).toBe(`Child job ${String(childId)} failed: ${error}`);
    return;
  }
  expect(state).toBe('waiting');
  if (policy === 'ignoreDependencyOnFailure') {
    expect(await manager.getIgnoredChildrenFailures(parentId)).toEqual({ [key]: error });
  }
  if (policy === 'continueParentOnFailure') {
    expect(await manager.getFailedChildrenValues(parentId)).toEqual({ [key]: error });
  }
}
