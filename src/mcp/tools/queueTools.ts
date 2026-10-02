/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Queue Control
 * List, count, pause, resume, drain, obliterate, clean, get jobs
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import type { JobCounts } from '../types/adapter';
import { queueField } from './schemas';
import { withErrorHandler } from './withErrorHandler';

/** States bunqueue_get_jobs can filter on (every state both backends can list). */
const LISTABLE_STATES = [
  'waiting',
  'prioritized',
  'delayed',
  'active',
  'completed',
  'failed',
  'paused',
  'waiting-children',
] as const;

/** Total jobs of a queue; the paused view keeps every job in exactly one bucket. */
function totalJobs(counts: JobCounts): number {
  return (
    counts.waiting +
    counts.prioritized +
    counts.delayed +
    counts.active +
    counts.completed +
    counts.failed +
    counts.paused +
    (counts['waiting-children'] ?? 0)
  );
}

export function registerQueueTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_list_queues',
    'List all queues.',
    {},
    withErrorHandler('bunqueue_list_queues', async () => {
      const queues = await backend.listQueues();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ queues }) }] };
    })
  );

  server.tool(
    'bunqueue_count_jobs',
    'Count every job of a queue across all states: waiting, prioritized, delayed, active, completed, failed (DLQ), paused and waiting-children. Use bunqueue_get_job_counts for the per-state breakdown.',
    {
      queue: queueField(),
    },
    withErrorHandler('bunqueue_count_jobs', async ({ queue }) => {
      const count = totalJobs(await backend.getJobCounts(queue));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ queue, count }) }] };
    })
  );

  server.tool(
    'bunqueue_get_jobs',
    'List jobs in a queue with optional state filter and pagination. Waiting jobs that have a priority are in the prioritized state; the ready jobs of a paused queue are in the paused state.',
    {
      queue: queueField(),
      state: z.enum(LISTABLE_STATES).optional().describe('Filter by job state'),
      start: z.number().int().min(0).optional().describe('Start index for pagination (default: 0)'),
      end: z.number().int().min(0).optional().describe('End index for pagination (default: 20)'),
    },
    withErrorHandler('bunqueue_get_jobs', async ({ queue, state, start, end }) => {
      const jobs = await backend.getJobs(queue, { state, start: start ?? 0, end: end ?? 20 });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ queue, count: jobs.length, jobs }, null, 2),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_get_job_counts',
    'Get job counts per state for a queue: waiting, prioritized, delayed, active, completed, failed (DLQ), paused and waiting-children. When the queue is paused its ready jobs are counted only under paused.',
    {
      queue: queueField(),
    },
    withErrorHandler('bunqueue_get_job_counts', async ({ queue }) => {
      const counts = await backend.getJobCounts(queue);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ queue, ...counts }) }] };
    })
  );

  server.tool(
    'bunqueue_pause_queue',
    'Pause job processing on a queue. No new jobs will be processed until resumed.',
    {
      queue: queueField(),
    },
    withErrorHandler('bunqueue_pause_queue', async ({ queue }) => {
      await backend.pauseQueue(queue);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, queue, message: 'Queue paused' }),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_resume_queue',
    'Resume job processing on a paused queue.',
    {
      queue: queueField(),
    },
    withErrorHandler('bunqueue_resume_queue', async ({ queue }) => {
      await backend.resumeQueue(queue);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, queue, message: 'Queue resumed' }),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_drain_queue',
    'Remove every job still waiting to run from a queue: waiting, prioritized and delayed jobs. Active jobs keep running; completed and failed jobs are kept.',
    {
      queue: queueField(),
    },
    withErrorHandler('bunqueue_drain_queue', async ({ queue }) => {
      const removed = await backend.drainQueue(queue);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ success: true, queue, removed }) },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_obliterate_queue',
    'Remove ALL data from a queue (waiting, active, completed, failed). Destructive operation.',
    {
      queue: queueField(),
    },
    withErrorHandler('bunqueue_obliterate_queue', async ({ queue }) => {
      await backend.obliterateQueue(queue);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, queue, message: 'Queue obliterated' }),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_clean_queue',
    'Remove old completed and/or failed jobs from a queue. Waiting, delayed and active jobs are never touched.',
    {
      queue: queueField(),
      graceMs: z.number().min(0).describe('Grace period in ms - only remove jobs older than this'),
      state: z
        .enum(['completed', 'failed'])
        .optional()
        .describe('State to clean (default: both completed and failed)'),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Maximum number of jobs to remove in total (default: 1000 per state)'),
    },
    withErrorHandler('bunqueue_clean_queue', async ({ queue, graceMs, state, limit }) => {
      // Never pass an undefined state: the broker treats it as "waiting".
      const ids: string[] = [];
      for (const target of state ? [state] : (['completed', 'failed'] as const)) {
        const remaining = limit === undefined ? undefined : limit - ids.length;
        if (remaining !== undefined && remaining <= 0) break;
        ids.push(...(await backend.cleanQueue(queue, graceMs, target, remaining)));
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, queue, removed: ids.length, ids }),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_is_paused',
    'Check if a queue is currently paused.',
    {
      queue: queueField(),
    },
    withErrorHandler('bunqueue_is_paused', async ({ queue }) => {
      const paused = await backend.isPaused(queue);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ queue, paused }) }] };
    })
  );

  server.tool(
    'bunqueue_get_counts_per_priority',
    'Get job count breakdown by priority level for a queue. Counts only waiting/delayed (queued) jobs — active, completed and failed jobs are not included.',
    {
      queue: queueField(),
    },
    withErrorHandler('bunqueue_get_counts_per_priority', async ({ queue }) => {
      const counts = await backend.getCountsPerPriority(queue);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ queue, priorities: counts }, null, 2) },
        ],
      };
    })
  );
}
