/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Job Operations
 * Add, get, cancel, promote jobs
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import { jobNameField, jobOptionsShape, queueField } from './schemas';
import { withErrorHandler } from './withErrorHandler';

export function registerJobTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_add_job',
    'Add a job to a queue. Returns the job ID (with jobId set: the custom id, or the existing job when that id is still unfinished; with deduplication: the existing job when the key is taken).',
    {
      queue: queueField(),
      name: jobNameField(),
      data: z.record(z.string(), z.unknown()).describe('Job payload data'),
      ...jobOptionsShape(),
    },
    withErrorHandler('bunqueue_add_job', async ({ queue, name, data, ...opts }) => {
      const result = await backend.addJob(queue, name, data, opts);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_add_jobs_bulk',
    'Add multiple jobs to a queue in a single operation; each job accepts the same options as bunqueue_add_job. Returns one id per job, in order (an existing id for a job suppressed by jobId or deduplication). The batch is ordered, not atomic: invalid options reject the whole call, but a job the broker refuses while admitting leaves the jobs before it added.',
    {
      queue: queueField(),
      jobs: z
        .array(
          z.object({
            name: jobNameField(),
            data: z.record(z.string(), z.unknown()),
            ...jobOptionsShape(),
          })
        )
        .describe('Array of jobs to add'),
    },
    withErrorHandler('bunqueue_add_jobs_bulk', async ({ queue, jobs }) => {
      const result = await backend.addJobsBulk(queue, jobs);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_get_job',
    'Get a job by ID: name, queue, data, state, priority, progress, attempts, timestamps, its backoff, and the add options it carries when set (timeout, stallTimeout, lifo, removeOnComplete, removeOnFail, tags, deduplicationId).',
    {
      jobId: z.string().describe('Job ID'),
    },
    withErrorHandler('bunqueue_get_job', async ({ jobId }) => {
      const job = await backend.getJob(jobId);
      if (!job) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Job not found' }) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(job, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_get_job_state',
    'Get the current state of a job: waiting, prioritized (waiting with a priority), delayed, active, completed, failed (in the DLQ), waiting-children (a flow parent waiting for its children), or unknown (no such job).',
    {
      jobId: z.string().describe('Job ID'),
    },
    withErrorHandler('bunqueue_get_job_state', async ({ jobId }) => {
      const state = await backend.getJobState(jobId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ jobId, state }) }] };
    })
  );

  server.tool(
    'bunqueue_get_job_result',
    'Get the result of a completed job.',
    {
      jobId: z.string().describe('Job ID'),
    },
    withErrorHandler('bunqueue_get_job_result', async ({ jobId }) => {
      const result = await backend.getJobResult(jobId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ jobId, result }, null, 2) }],
      };
    })
  );

  server.tool(
    'bunqueue_cancel_job',
    'Cancel a waiting or delayed job.',
    {
      jobId: z.string().describe('Job ID to cancel'),
    },
    withErrorHandler('bunqueue_cancel_job', async ({ jobId }) => {
      const success = await backend.cancelJob(jobId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId }) }] };
    })
  );

  server.tool(
    'bunqueue_promote_job',
    'Promote a delayed job to waiting state for immediate processing.',
    {
      jobId: z.string().describe('Job ID to promote'),
    },
    withErrorHandler('bunqueue_promote_job', async ({ jobId }) => {
      const success = await backend.promoteJob(jobId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId }) }] };
    })
  );

  server.tool(
    'bunqueue_update_progress',
    'Update job progress (0-100).',
    {
      jobId: z.string().describe('Job ID'),
      progress: z.number().min(0).max(100).describe('Progress value (0-100)'),
      message: z.string().optional().describe('Optional progress message'),
    },
    withErrorHandler('bunqueue_update_progress', async ({ jobId, progress, message }) => {
      const success = await backend.updateProgress(jobId, progress, message);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId, progress }) }],
      };
    })
  );

  server.tool(
    'bunqueue_get_children_values',
    'Get return values from all child jobs of a parent job. Used with FlowProducer workflows.',
    {
      parentJobId: z.string().describe('Parent job ID'),
    },
    withErrorHandler('bunqueue_get_children_values', async ({ parentJobId }) => {
      const values = await backend.getChildrenValues(parentJobId);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ parentJobId, children: values }, null, 2),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_get_job_by_custom_id',
    'Look up an unfinished job by the custom ID it was added with (the jobId option of bunqueue_add_job, bunqueue_add_jobs_bulk, the flow tools, the client SDK or the HTTP API). The custom ID is released when the job completes or fails for good, so this lookup then reports not found; a custom ID is also the job ID, so bunqueue_get_job still finds the finished job.',
    {
      customId: z.string().describe('Custom job ID'),
    },
    withErrorHandler('bunqueue_get_job_by_custom_id', async ({ customId }) => {
      const job = await backend.getJobByCustomId(customId);
      if (!job) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Job not found' }) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(job, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_wait_for_job',
    'Wait for a job to complete within a timeout. Returns completed: true as soon as the job has completed (at once if it already had), false if the timeout expires first.',
    {
      jobId: z.string().describe('Job ID to wait for'),
      timeoutMs: z.number().min(100).max(30000).describe('Maximum wait time in milliseconds'),
    },
    withErrorHandler('bunqueue_wait_for_job', async ({ jobId, timeoutMs }) => {
      const completed = await backend.waitForJobCompletion(jobId, timeoutMs);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ jobId, completed }) }] };
    })
  );
}
