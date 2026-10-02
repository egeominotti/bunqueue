/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Workflow engine executions (opt-in: BUNQUEUE_MCP_WORKFLOW_DB)
 * List and inspect runs from the Engine's execution store, and deliver a
 * human-in-the-loop signal to a run parked at waitFor.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import type { WorkflowToolsContext } from '../workflow/config';
import { deliverSignal } from '../workflow/signal';
import { executionDetail, executionSummary } from '../workflow/views';
import { withErrorHandler } from './withErrorHandler';

const EXECUTION_STATES = [
  'running',
  'waiting',
  'completed',
  'failed',
  'compensating',
  'compensation-stuck',
] as const;
const DEFAULT_LIST_LIMIT = 50;
/** WorkflowStore listing cap (storeListing.ts). */
const MAX_LIST_LIMIT = 1000;

function text(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError } : {}),
  };
}

export function registerWorkflowTools(
  server: McpServer,
  backend: McpBackend,
  ctx: WorkflowToolsContext
) {
  server.tool(
    'bunqueue_list_workflow_executions',
    "List workflow engine executions from the Engine's workflow database (BUNQUEUE_MCP_WORKFLOW_DB), newest first. Filter by workflow name and state; page with limit/offset (nextOffset is null once a page comes back short). Each row: id, workflow name, state, current node index, the event a waiting run waits for (known only for waitFor gates with a timeout, otherwise null), names of the signals received, failure reason, rollback status, parent execution, timestamps. Node names are not available: step definitions live in the application.",
    {
      workflowName: z.string().min(1).optional().describe('Only executions of this workflow'),
      state: z.enum(EXECUTION_STATES).optional().describe('Only executions in this state'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIST_LIMIT)
        .optional()
        .describe(`Page size (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT})`),
      offset: z.number().int().min(0).optional().describe('Rows to skip (default 0)'),
    },
    withErrorHandler(
      'bunqueue_list_workflow_executions',
      async ({ workflowName, state, limit = DEFAULT_LIST_LIMIT, offset = 0 }) => {
        const rows = ctx.db.list(workflowName, state, { limit, offset });
        return text({
          executions: rows.map(executionSummary),
          count: rows.length,
          limit,
          offset,
          nextOffset: rows.length === limit ? offset + limit : null,
        });
      }
    )
  );

  server.tool(
    'bunqueue_get_workflow_execution',
    'Get one workflow engine execution by id: state, workflow name, current node index, the event a waiting run waits for (known only for waitFor gates with a timeout), every step record (status, attempts, error, result, start/end time, compensation outcome; engine bookkeeping records start with "__" or "sub:"), the signals received with their payloads, input, failure reason, rollback status and timestamps. Values the JSON format cannot carry are converted (BigInt to string, Date to ISO string, Map/Set/bytes/Error to tagged objects).',
    { executionId: z.string().min(1).describe('Workflow execution id (engine.start() result)') },
    withErrorHandler('bunqueue_get_workflow_execution', async ({ executionId }) => {
      const exec = ctx.db.get(executionId);
      if (!exec) return text({ error: `Workflow execution "${executionId}" not found` }, true);
      return text(executionDetail(exec));
    })
  );

  if (ctx.signalUnavailable !== null) return;
  server.tool(
    'bunqueue_signal_workflow',
    `Deliver a human-in-the-loop signal (for example an approval) to a workflow execution, like engine.signal(executionId, event, payload) in the application. The first signal for an event wins and can never be changed or withdrawn; signals are kept by name, so it also opens a later waitFor with the same event. A run parked at a waitFor resumes: this tool enqueues its next step job on queue "${ctx.queue}", and the application's Engine, connected to this same bunqueue server, runs it (this MCP server never runs workflow steps). A run that is still running keeps the signal until it reaches the gate. Fails, recording nothing, for an unknown execution, a run that already finished or failed, a duplicate signal, or an event other than the one a timed gate is waiting for. Returns { recorded, resumed }.`,
    {
      executionId: z.string().min(1).describe('Workflow execution id'),
      event: z.string().min(1).describe('Event name of the waitFor gate, e.g. "approval"'),
      payload: z
        .unknown()
        .optional()
        .describe('Any JSON value; the run reads it as ctx.signals[event]'),
    },
    withErrorHandler('bunqueue_signal_workflow', async ({ executionId, event, payload }) => {
      const reply = await deliverSignal(
        { db: ctx.db, backend, queue: ctx.queue },
        { executionId, event, payload }
      );
      return text(reply.body, reply.isError);
    })
  );
}
