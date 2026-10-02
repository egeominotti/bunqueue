/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Job Management
 * Update data, change priority, delay, discard
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import { delayField, priorityField } from './schemas';
import { withErrorHandler } from './withErrorHandler';

export function registerJobMgmtTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_update_job_data',
    'Update the payload data of a job.',
    {
      jobId: z.string().describe('Job ID'),
      data: z.record(z.string(), z.unknown()).describe('New job payload data'),
    },
    withErrorHandler('bunqueue_update_job_data', async ({ jobId, data }) => {
      const success = await backend.updateJobData(jobId, data);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId }) }] };
    })
  );

  server.tool(
    'bunqueue_change_job_priority',
    'Change the priority of a waiting job. Higher priority = processed first.',
    {
      jobId: z.string().describe('Job ID'),
      priority: priorityField('New priority value'),
    },
    withErrorHandler('bunqueue_change_job_priority', async ({ jobId, priority }) => {
      const success = await backend.changeJobPriority(jobId, priority);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId, priority }) }],
      };
    })
  );

  server.tool(
    'bunqueue_move_to_delayed',
    'Move a job to the delayed state so it runs again after the given delay: an active job is released by its worker and rescheduled, a waiting/prioritized/delayed job is rescheduled. Completed and failed jobs cannot be moved (success: false). A job locked by a pull with an owner cannot be moved here (error "Lock token required"): finish it with bunqueue_ack_job / bunqueue_fail_job and its token, or let the lock expire.',
    {
      jobId: z.string().describe('Job ID'),
      delay: delayField('Delay in milliseconds'),
    },
    withErrorHandler('bunqueue_move_to_delayed', async ({ jobId, delay }) => {
      const success = await backend.moveToDelayed(jobId, delay);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId, delay }) }],
      };
    })
  );

  server.tool(
    'bunqueue_discard_job',
    'Discard a job: it is moved to the dead letter queue (state failed) without being processed. It is not deleted: inspect it with bunqueue_get_dlq and run it again with bunqueue_retry_dlq. A job locked by a pull with an owner cannot be discarded here (error "Lock token required"): use bunqueue_fail_job with its token and unrecoverable: true.',
    {
      jobId: z.string().describe('Job ID to discard'),
    },
    withErrorHandler('bunqueue_discard_job', async ({ jobId }) => {
      const success = await backend.discardJob(jobId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId }) }] };
    })
  );

  server.tool(
    'bunqueue_get_progress',
    'Get the progress and progress message of a job in any state (the last value reported while it was active).',
    {
      jobId: z.string().describe('Job ID'),
    },
    withErrorHandler('bunqueue_get_progress', async ({ jobId }) => {
      // A backend may only report live progress (active jobs); any other existing job
      // still has a stored progress value, so "not found" means the job does not exist.
      let result = await backend.getProgress(jobId);
      if (!result) {
        const job = await backend.getJob(jobId);
        if (job) result = { progress: job.progress, message: null };
      }
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Job not found' }) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ jobId, ...result }) }] };
    })
  );

  server.tool(
    'bunqueue_change_delay',
    'Change the delay of a delayed job. A job locked by a pull with an owner is rejected (error "Lock token required").',
    {
      jobId: z.string().describe('Job ID'),
      delay: delayField('New delay in milliseconds'),
    },
    withErrorHandler('bunqueue_change_delay', async ({ jobId, delay }) => {
      const success = await backend.changeDelay(jobId, delay);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId, delay }) }],
      };
    })
  );
}
