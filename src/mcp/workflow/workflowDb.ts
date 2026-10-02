/**
 * Access to the workflow Engine's SQLite execution store from the MCP server.
 *
 * The file belongs to the application (it is the Engine's `dataPath`), so this class
 * never creates it, never runs the store's DDL/migrations, and holds no connection
 * between calls: every operation opens the existing file read-write without the
 * create flag, sets the same busy timeout as WorkflowStore, and closes it again,
 * finalizing every statement prepared on it (see use()).
 *
 * A fresh connection per call is deliberate. bun:sqlite fixes a prepared statement's
 * result columns when it first runs, so a long-lived `SELECT *` would silently drop a
 * column the application's Engine adds by migration after this server started.
 *
 * Reads and signal writes reuse the engine's own store building blocks
 * (ExecutionListing, decodeExecution, SignalCoordinator), so the MCP server records a
 * signal through exactly the transactional, first-writer-wins path engine.signal()
 * uses. The only SQL here is a primary-key lookup and the schema checks.
 */

import { Database } from 'bun:sqlite';
import { decodeExecution } from '../../client/workflow/storeExecutionCodec';
import { ExecutionListing } from '../../client/workflow/storeListing';
import { SignalCoordinator } from '../../client/workflow/storeSignals';
import type {
  Execution,
  ExecutionListOptions,
  ExecutionState,
  SignalOutcome,
} from '../../client/workflow/types';

/** Same value WorkflowStore uses: the Engine writes this file concurrently. */
const BUSY_TIMEOUT_MS = 5000;

function hasTable(db: Database, name: string): boolean {
  return (
    db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== null
  );
}

export class WorkflowDb {
  constructor(readonly path: string) {}

  /**
   * Throw unless `path` is an existing workflow store. Opening without the create
   * flag means a missing file fails here instead of being created empty.
   */
  assertWorkflowStore(): void {
    let found: boolean;
    try {
      found = this.use((db) => hasTable(db, 'workflow_executions'));
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`BUNQUEUE_MCP_WORKFLOW_DB "${this.path}" cannot be opened (${cause})`);
    }
    if (!found) {
      throw new Error(
        `BUNQUEUE_MCP_WORKFLOW_DB "${this.path}" is not a bunqueue workflow database (no workflow_executions table); set it to the Engine's dataPath file`
      );
    }
  }

  /**
   * Whether the file also holds a bunqueue broker's `jobs` table. An embedded Engine
   * hands its dataPath to its in-process queue as well, so its step queue lives in
   * this file and inside the application process, out of reach of any MCP backend.
   */
  holdsQueueTables(): boolean {
    return this.use((db) => hasTable(db, 'jobs'));
  }

  get(id: string): Execution | null {
    return this.use((db) => {
      const row = db.query(`SELECT * FROM workflow_executions WHERE id = ?`).get(id) as Record<
        string,
        unknown
      > | null;
      return row ? decodeExecution(row) : null;
    });
  }

  list(workflowName?: string, state?: ExecutionState, options?: ExecutionListOptions) {
    return this.use((db) => new ExecutionListing(db).list(workflowName, state, options));
  }

  /** WorkflowStore.recordSignal(): first writer wins, claims the single resume. */
  recordSignal(id: string, event: string, payload: unknown): SignalOutcome {
    return this.use((db) => new SignalCoordinator(db).record(id, event, payload));
  }

  /** WorkflowStore.restoreSignalWait(): release the resume claim, keep the signal. */
  restoreSignalWait(id: string, event: string, nodeIndex: number): boolean {
    return this.use((db) => new SignalCoordinator(db).restoreWaiting(id, event, nodeIndex));
  }

  private use<T>(fn: (db: Database) => T): T {
    const db = new Database(this.path, { readwrite: true, create: false });
    try {
      db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      return fn(db);
    } finally {
      // close(true), not close(): ExecutionListing and SignalCoordinator prepare
      // statements that are still alive here. A plain close() only defers the release
      // until they are collected, which leaked the connection and its database, WAL and
      // shared-memory handles on every call (test/repro-mcp-workflow-db-handles.test.ts).
      // close(true) finalizes them and releases the connection now.
      db.close(true);
    }
  }
}
