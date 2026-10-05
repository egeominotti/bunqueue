/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Flow Operations
 * Create and retrieve job workflows: chains, fan-out/fan-in, and tree flows.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend, FlowJobInput } from '../adapter';
import {
  attemptsField,
  backoffField,
  customJobIdField,
  jobDelayField,
  jobNameField,
  priorityField,
  queueField,
  stallTimeoutField,
  timeoutField,
} from './schemas';
import { withErrorHandler } from './withErrorHandler';

/**
 * Options of one flow job. A flow is committed atomically and always written durably;
 * the broker rejects deduplication inside a flow and does not store tags on flow jobs,
 * so the object is strict: an unsupported option is an error, never silently dropped.
 */
const jobOptsSchema = z
  .strictObject({
    priority: priorityField().optional(),
    delay: jobDelayField().optional(),
    attempts: attemptsField().optional(),
    backoff: backoffField().optional(),
    timeout: timeoutField().optional(),
    jobId: customJobIdField(
      'Custom job id: must be new and contain no ":" (a flow is not idempotent)'
    ).optional(),
    removeOnComplete: z.boolean().optional().describe('Delete the job once it completes'),
    removeOnFail: z
      .boolean()
      .optional()
      .describe('Delete the job instead of moving it to the DLQ when it finally fails'),
    lifo: z.boolean().optional().describe('Run before older ready jobs of the same priority'),
    stallTimeout: stallTimeoutField().optional(),
  })
  .optional()
  .describe('Job settings (deduplication, tags and durable are not available in flows)');

/** Shared schema for flow step */
const flowStepSchema = z.object({
  name: jobNameField(),
  queueName: queueField('Queue to run in'),
  data: z.record(z.string(), z.unknown()).describe('Job payload data'),
  opts: jobOptsSchema,
});

/**
 * Recursive FlowJob schema.
 * z.lazy() enables self-referencing for nested children.
 */
const flowJobSchema: z.ZodType = z.lazy(() =>
  z.object({
    name: jobNameField(),
    queueName: queueField('Queue to run in'),
    data: z.record(z.string(), z.unknown()).optional().describe('Job payload data'),
    opts: jobOptsSchema,
    children: z.array(flowJobSchema).optional().describe('Child jobs (processed BEFORE parent)'),
  })
);

export function registerFlowTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_add_flow',
    'Create a job flow tree (BullMQ v5 compatible). Children are processed BEFORE their parent. Use for complex dependency graphs.',
    {
      name: jobNameField('Root job name/type'),
      queueName: queueField('Root queue name'),
      data: z.record(z.string(), z.unknown()).optional().describe('Root job payload'),
      opts: jobOptsSchema,
      children: z
        .array(flowJobSchema)
        .optional()
        .describe('Child jobs (processed BEFORE this job)'),
    },
    withErrorHandler('bunqueue_add_flow', async ({ name, queueName, data, opts, children }) => {
      const result = await backend.addFlow({
        name,
        queueName,
        data,
        opts,
        children: children as FlowJobInput[] | undefined,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_add_flow_chain',
    'Create a sequential job pipeline: step[0] → step[1] → step[2]. Each step depends on the previous one completing first.',
    {
      steps: z
        .array(flowStepSchema)
        .min(1)
        .describe('Steps executed in order, each depending on the previous'),
    },
    withErrorHandler('bunqueue_add_flow_chain', async ({ steps }) => {
      const result = await backend.addFlowChain(steps);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_add_flow_bulk_then',
    'Fan-out/fan-in: run parallel jobs, then execute a final job when ALL parallel jobs complete.',
    {
      parallel: z.array(flowStepSchema).min(1).describe('Jobs that run in parallel'),
      final: flowStepSchema.describe('Final job that runs after all parallel jobs complete'),
    },
    withErrorHandler('bunqueue_add_flow_bulk_then', async ({ parallel, final: finalStep }) => {
      const result = await backend.addFlowBulkThen(parallel, finalStep);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_get_flow',
    'Retrieve a flow tree starting from a job. Shows the full dependency graph with children.',
    {
      jobId: z.string().describe('Job ID to get flow tree for'),
      queueName: queueField('Queue name where the job is located'),
      depth: z.number().int().min(1).optional().describe('Max traversal depth (default: 10)'),
      maxChildren: z.number().int().min(1).optional().describe('Max children per level'),
    },
    withErrorHandler('bunqueue_get_flow', async ({ jobId, queueName, depth, maxChildren }) => {
      const result = await backend.getFlow(jobId, queueName, depth ?? 10, maxChildren);
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Flow not found' }) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    })
  );
}
