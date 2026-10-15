/* eslint-disable @typescript-eslint/no-deprecated */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import { diagnoseQueue } from '../diagnostics';
import { INSPECTION_STATES, listJobsPage } from '../inspectionPage';
import { observeJob } from '../jobObservation';
import { queueField } from './schemas';
import { withErrorHandler } from './withErrorHandler';

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function registerObservationTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_diagnose_queue',
    'Read a queue snapshot with every state count, current limits and bounded safe samples. Reports observed constraints, not inferred root causes.',
    { queue: queueField().max(1024) },
    withErrorHandler('bunqueue_diagnose_queue', async ({ queue }) =>
      textResult(await diagnoseQueue(backend, queue))
    )
  );
  server.tool(
    'bunqueue_list_jobs_page',
    'Read a bounded queue page (limit 1..100). Payloads are omitted unless includeData is true; hasMore probes one extra row. Offsets are live, not a stable snapshot.',
    {
      queue: queueField().max(1024),
      state: z.enum(INSPECTION_STATES).optional(),
      offset: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER - 101)
        .optional(),
      limit: z.number().int().min(1).max(100).optional(),
      includeData: z.boolean().optional(),
    },
    withErrorHandler('bunqueue_list_jobs_page', async (args) =>
      textResult(await listJobsPage(backend, args))
    )
  );
  // The request signal must survive wrapping: the historical error wrapper only accepts args.
  const observe = withErrorHandler(
    'bunqueue_observe_job',
    async (input: {
      jobId: string;
      timeoutMs?: number;
      pollIntervalMs?: number;
      signal: AbortSignal;
    }) => textResult(await observeJob(backend, input, input.signal))
  );
  server.tool(
    'bunqueue_observe_job',
    'Observe completion or permanent failure using read-only polling. Unknown/removed jobs never imply success. timeoutMs 0 is a snapshot; cancellation stops polling. Legacy wait_for_job is unchanged.',
    {
      jobId: z.string().min(1).max(1024),
      timeoutMs: z.number().int().min(0).max(30000).optional(),
      pollIntervalMs: z.number().int().min(25).max(1000).optional(),
    },
    (args, extra) => observe({ ...args, signal: extra.signal })
  );
}
