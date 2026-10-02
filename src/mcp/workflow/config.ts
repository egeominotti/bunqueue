/**
 * Opt-in configuration of the MCP workflow tools.
 *
 * - BUNQUEUE_MCP_WORKFLOW_DB: the workflow Engine's `dataPath` file. Unset → no
 *   workflow tool is registered. Set → the file must already exist and contain the
 *   workflow store, otherwise the MCP server refuses to start (it never creates one).
 * - BUNQUEUE_MCP_WORKFLOW_QUEUE: the Engine's step queue (EngineOptions.queueName),
 *   default `__wf:steps`.
 *
 * The Engine keeps its workflow definitions (step code) in the application process.
 * This server reads the execution store and, to deliver a signal, enqueues the resume
 * job; it never runs steps, compensations or recovery. Signals therefore need the
 * application's Engine to consume the same bunqueue server this MCP backend talks to.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { EmbeddedBackend, type McpBackend } from '../adapter';
import { WorkflowDb } from './workflowDb';

export const DEFAULT_WORKFLOW_QUEUE = '__wf:steps';

export interface WorkflowToolsContext {
  db: WorkflowDb;
  /** The Engine's step queue, where a resumed run's next job is enqueued. */
  queue: string;
  /** Why bunqueue_signal_workflow is not offered, or null when it is. */
  signalUnavailable: string | null;
}

/** Validate the workflow settings; null when BUNQUEUE_MCP_WORKFLOW_DB is unset. */
export function workflowToolsFromEnv(
  env: NodeJS.ProcessEnv,
  backend: McpBackend
): WorkflowToolsContext | null {
  const raw = env.BUNQUEUE_MCP_WORKFLOW_DB?.trim();
  const queue = env.BUNQUEUE_MCP_WORKFLOW_QUEUE?.trim();
  if (!raw) {
    if (queue) {
      process.stderr.write(
        'bunqueue MCP: BUNQUEUE_MCP_WORKFLOW_QUEUE is ignored because BUNQUEUE_MCP_WORKFLOW_DB is not set\n'
      );
    }
    return null;
  }

  const path = resolve(raw);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(
      `BUNQUEUE_MCP_WORKFLOW_DB "${path}" does not exist or is not a file; set it to the existing dataPath file of the workflow Engine (the MCP server never creates a workflow database)`
    );
  }
  const db = new WorkflowDb(path);
  db.assertWorkflowStore();

  let signalUnavailable: string | null = null;
  if (backend instanceof EmbeddedBackend) {
    signalUnavailable =
      'the MCP server runs embedded, so a resume job would land in its own in-process queue, which no Engine consumes; run it with BUNQUEUE_MODE=tcp against the bunqueue server the application Engine connects to';
  } else if (db.holdsQueueTables()) {
    signalUnavailable =
      "the workflow database also holds bunqueue's jobs table, so the Engine runs embedded and its step queue lives inside the application process; call engine.signal() in the application, or connect the Engine to a bunqueue server over TCP with a dataPath of its own";
  }
  return { db, queue: queue || DEFAULT_WORKFLOW_QUEUE, signalUnavailable };
}
