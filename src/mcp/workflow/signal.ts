/**
 * Deliver a workflow signal from the MCP server, mirroring engine.signal()
 * (signalExecution in src/client/workflow/executorLifecycle.ts):
 *
 * 1. record the payload through the store's transactional coordinator: first writer
 *    wins, a duplicate event is rejected, and only a run parked in `waiting` is
 *    claimed for resume (state -> running);
 * 2. if this call claimed the resume, publish the same `wf:step` job the engine
 *    would, for the parked node, on the Engine's step queue;
 * 3. if publishing fails, put the wait back (the signal stays recorded) so the
 *    application's recover() republishes the node.
 *
 * The MCP server only enqueues: the application's Engine worker runs the step.
 */

import { unusableEventName } from '../../client/workflow/workflowValidation';
import type { McpBackend } from '../types/adapter';
import { toJsonSafe } from './jsonSafe';
import { awaitedEvent } from './views';
import type { WorkflowDb } from './workflowDb';

/** Job name the Engine's worker consumes (executorQueue.ts / executorLifecycle.ts). */
const STEP_JOB_NAME = 'wf:step';
const PAYLOAD_PREVIEW_CHARS = 500;

export interface SignalContext {
  db: WorkflowDb;
  backend: McpBackend;
  /** The Engine's step queue (EngineOptions.queueName). */
  queue: string;
}

export interface SignalRequest {
  executionId: string;
  event: string;
  payload?: unknown;
}

export interface SignalReply {
  isError: boolean;
  body: Record<string, unknown>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Throws for requests nothing was recorded for; returns a reply once recorded. */
export async function deliverSignal(ctx: SignalContext, req: SignalRequest): Promise<SignalReply> {
  const { executionId, event, payload } = req;
  const bad = unusableEventName(event);
  if (bad) throw new Error(`Cannot signal an event ${bad}`);

  const current = ctx.db.get(executionId);
  if (!current) throw new Error(`Workflow execution "${executionId}" not found`);
  const awaited = awaitedEvent(current);
  if (awaited !== null && awaited !== event) {
    // Signals are kept by name and never consumed: a wrong name would not open this
    // gate, but would silently pre-open a later waitFor with that name.
    throw new Error(
      `Execution "${executionId}" is waiting for the event "${awaited}", not "${event}"; nothing was recorded`
    );
  }

  const outcome = ctx.db.recordSignal(executionId, event, payload);
  if (!outcome.found) throw new Error(`Workflow execution "${executionId}" not found`);
  const recorded = { executionId, workflowName: outcome.workflowName, event, recorded: true };
  if (!outcome.resumed) {
    return {
      isError: false,
      body: {
        ...recorded,
        resumed: false,
        note: 'The run is not parked at a waitFor yet; the signal is stored and opens waitFor of this event when the run reaches it.',
      },
    };
  }

  const nodeIndex = outcome.currentNodeIndex;
  try {
    // removeOnComplete matches the Engine's own step jobs, which are never retained.
    const job = await ctx.backend.addJob(
      ctx.queue,
      STEP_JOB_NAME,
      { executionId, workflowName: outcome.workflowName, nodeIndex },
      { removeOnComplete: true }
    );
    return {
      isError: false,
      body: { ...recorded, resumed: true, nodeIndex, queue: ctx.queue, jobId: job.jobId },
    };
  } catch (err) {
    let restored = false;
    try {
      restored = ctx.db.restoreSignalWait(executionId, event, nodeIndex);
    } catch {
      // The row stays running with its signal; the application's recover() re-drives it.
    }
    return {
      isError: true,
      body: {
        ...recorded,
        resumed: false,
        restored,
        error: `The signal was recorded, but the resume job could not be enqueued on "${ctx.queue}": ${message(err)}`,
        next: 'Do not send the signal again (it would be rejected as a duplicate). The run resumes when the application calls engine.recover(), e.g. on restart, or when its waitFor timeout re-check runs.',
      },
    };
  }
}

function preview(payload: unknown): string {
  if (payload === undefined) return 'no payload';
  const text = JSON.stringify(toJsonSafe(payload));
  return `payload ${text.length > PAYLOAD_PREVIEW_CHARS ? `${text.slice(0, PAYLOAD_PREVIEW_CHARS)}...` : text}`;
}

/** Confirmation text for bunqueue_signal_workflow (see confirmImpact.ts). */
export function describeSignalImpact(db: WorkflowDb, args: Record<string, unknown>): string {
  const executionId = String(args.executionId ?? '');
  const event = String(args.event ?? '');
  const head = `Deliver signal "${event}" with ${preview(args.payload)} to workflow execution ${executionId}`;
  const exec = db.get(executionId);
  if (!exec) return `${head} (not found).`;

  let where: string;
  if (exec.state === 'waiting') {
    const awaited = awaitedEvent(exec);
    const gate = awaited ? `waiting for "${awaited}"` : 'parked at a waitFor';
    where = `${gate} at node #${exec.currentNodeIndex}; it resumes and runs the steps after the gate`;
  } else if (exec.state === 'running') {
    where = `still running at node #${exec.currentNodeIndex}; the signal is stored and opens waitFor("${event}") when the run reaches it`;
  } else {
    where = `${exec.state}; it can no longer receive signals`;
  }
  return `${head} of workflow "${exec.workflowName}" (${where}). The first signal for an event wins: it cannot be undone or replaced, and it also opens any later waitFor("${event}") of this run.`;
}
