import type { Database } from 'bun:sqlite';
import { isLive } from './admission';
import { clock } from './clock';
import { unpack } from './storeCodec';
import type { ExecutionMeta } from './storeExecutionCodec';
import type { Execution } from './types';

interface Candidate {
  id: string;
  workflow_name: string;
  state: Execution['state'];
  meta: Uint8Array | null;
}

type OwnerRow = Candidate & { steps: Uint8Array | null };
type ChildStatus = { running: boolean; rollbackSettled: boolean };
type Owner = Pick<Execution, 'state' | 'workflowName' | 'parentExecutionId'> & {
  rollbackClosed: boolean;
  children: Map<string, ChildStatus>;
};

function decodeOwner(row: OwnerRow): Owner {
  const meta = unpack(row.meta) as ExecutionMeta | null;
  const steps = unpack(row.steps) as Execution['steps'] | null;
  // The archive limit counts eligible rows, so this scan may visit every
  // owner. Keep only child obligations in the cache and release user payloads.
  const children = new Map<string, ChildStatus>();
  for (const [name, record] of Object.entries(steps ?? {})) {
    if (!name.startsWith('sub:')) continue;
    const outcome = record.compensation?.status;
    children.set(name, {
      running: record.status === 'running',
      rollbackSettled: outcome === 'compensated' || outcome === 'compensation-skipped',
    });
  }
  return {
    state: row.state,
    workflowName: row.workflow_name,
    parentExecutionId: meta?.parentExecutionId,
    rollbackClosed:
      meta?.committedAt !== undefined ||
      (row.state === 'failed' && meta?.rollbackStatus !== undefined),
    children,
  };
}

function retentionCheck(db: Database) {
  const readOwner = db.query<OwnerRow, [string]>(
    'SELECT id, workflow_name, state, meta, steps FROM workflow_executions WHERE id = ?'
  );
  const owners = new Map<string, Owner | null>();
  function owner(id: string): Owner | null {
    const cached = owners.get(id);
    if (cached !== undefined) return cached;
    const row = readOwner.get(id);
    const value = row && decodeOwner(row);
    owners.set(id, value);
    return value;
  }

  return (row: Candidate): boolean => {
    const meta = unpack(row.meta) as ExecutionMeta | null;
    // A failure persisted just before its unwind is recoverable in its own right.
    if (row.state === 'failed' && meta?.rollbackStatus === undefined) return true;
    let parentId = meta?.parentExecutionId;
    let name = row.workflow_name;
    const visited = new Set<string>();
    while (parentId !== undefined) {
      if (visited.has(parentId)) return true;
      visited.add(parentId);
      const parent = owner(parentId);
      if (!parent) return false;
      const record = parent.children.get(`sub:${name}`);
      // A forward parent may still need to adopt the child or read its result,
      // including when a pivot already disabled rollback.
      if (isLive(parent.state) && (!record || record.running)) return true;
      if (parent.rollbackClosed || record?.rollbackSettled) return false;
      if (parent.state !== 'completed') return true;
      // A completed intermediate can still be unwound through its own parent.
      name = parent.workflowName;
      parentId = parent.parentExecutionId;
    }
    return false;
  };
}

function criteria(states: string[]): string {
  return `updated_at <= ? AND state IN (${states.map(() => '?').join(',')})`;
}

export function cleanupExecutions(
  db: Database,
  maxAgeMs: number,
  states: string[] = ['completed', 'failed']
): number {
  const cutoff = clock().now() - maxAgeMs;
  const where = criteria(states);
  return db
    .transaction(() => {
      const retain = retentionCheck(db);
      const held: string[] = [];
      const query = db.prepare(
        `SELECT id, workflow_name, state, meta FROM workflow_executions WHERE ${where}`
      );
      for (const row of query.iterate(cutoff, ...states) as Iterable<Candidate>) {
        if (retain(row)) held.push(row.id);
      }
      return db
        .prepare(
          `DELETE FROM workflow_executions WHERE ${where} AND id NOT IN (SELECT value FROM json_each(?))`
        )
        .run(cutoff, ...states, JSON.stringify(held)).changes;
    })
    .immediate();
}

export function archiveExecutions(
  db: Database,
  maxAgeMs: number,
  states: string[] = ['completed', 'failed']
): number {
  const now = clock().now();
  return db
    .transaction(() => {
      const retain = retentionCheck(db);
      const selected: string[] = [];
      const query = db.prepare(
        `SELECT id, workflow_name, state, meta FROM workflow_executions WHERE ${criteria(states)}
       ORDER BY updated_at ASC, id ASC`
      );
      for (const row of query.iterate(now - maxAgeMs, ...states) as Iterable<Candidate>) {
        if (retain(row)) continue;
        selected.push(row.id);
        if (selected.length === 1000) break;
      }
      if (selected.length === 0) return 0;
      const ids = JSON.stringify(selected);
      const where = 'id IN (SELECT value FROM json_each(?))';
      db.prepare(
        `INSERT OR REPLACE INTO workflow_executions_archive
       (id, workflow_name, state, input, steps, current_node_index, resolved_steps,
        signals, created_at, updated_at, meta, archived_at)
       SELECT id, workflow_name, state, input, steps, current_node_index, resolved_steps,
              signals, created_at, updated_at, meta, ? FROM workflow_executions WHERE ${where}`
      ).run(now, ids);
      return db.prepare(`DELETE FROM workflow_executions WHERE ${where}`).run(ids).changes;
    })
    .immediate();
}

export function archivedExecutionCount(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM workflow_executions_archive').get() as {
    cnt: number;
  };
  return row.cnt;
}
