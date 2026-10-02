/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Dead Letter Queue Operations
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import { MAX_DLQ_ATTEMPTS_SHOWN } from '../backend/dlqView';
import { queueField } from './schemas';
import { withErrorHandler } from './withErrorHandler';

/** Failure reasons recorded on DLQ entries (the engine's FailureReason values). */
export const DLQ_FAILURE_REASONS = [
  'explicit_fail',
  'max_attempts_exceeded',
  'timeout',
  'stalled',
  'ttl_expired',
  'worker_lost',
  'unknown',
] as const;

const MAX_DLQ_PAGE = 100;

export function registerDlqTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_get_dlq',
    `Get Dead Letter Queue entries of a queue (jobs that permanently failed), oldest first. Each entry has the job plus why it failed: reason, last error, attempt history (the last ${MAX_DLQ_ATTEMPTS_SHOWN} attempts; attemptCount is the total), retryCount, enteredAt, lastRetryAt, nextRetryAt and expiresAt. Page with offset/limit while hasMore is true.`,
    {
      queue: queueField(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_DLQ_PAGE)
        .optional()
        .describe(`Max entries to return (default: 20, max ${MAX_DLQ_PAGE})`),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Matching entries to skip first (default: 0)'),
      reason: z
        .enum(DLQ_FAILURE_REASONS)
        .optional()
        .describe('Only entries whose last failure has this reason'),
    },
    withErrorHandler('bunqueue_get_dlq', async ({ queue, limit, offset, reason }) => {
      const page = await backend.getDlqEntries(queue, { limit: limit ?? 20, offset, reason });
      const result = {
        queue,
        ...(reason === undefined ? {} : { reason }),
        offset: offset ?? 0,
        count: page.entries.length,
        hasMore: page.hasMore,
        entries: page.entries,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_get_dlq_stats',
    'Summarize the Dead Letter Queue of a queue: total entries, entries per failure reason, entries due for automatic retry (pendingRetry), entries past their expiry awaiting purge (expired), and the oldest and newest entry times.',
    {
      queue: queueField(),
    },
    withErrorHandler('bunqueue_get_dlq_stats', async ({ queue }) => {
      const stats = await backend.getDlqStats(queue);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ queue, ...stats }, null, 2) }],
      };
    })
  );

  server.tool(
    'bunqueue_retry_dlq',
    'Retry jobs from the Dead Letter Queue. Moves them back to waiting state.',
    {
      queue: queueField(),
      jobId: z.string().optional().describe('Specific job ID to retry (omit to retry all)'),
    },
    withErrorHandler('bunqueue_retry_dlq', async ({ queue, jobId }) => {
      const retried = await backend.retryDlq(queue, jobId);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ success: true, queue, retried }) },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_purge_dlq',
    'Remove all entries from the Dead Letter Queue permanently.',
    {
      queue: queueField(),
    },
    withErrorHandler('bunqueue_purge_dlq', async ({ queue }) => {
      const purged = await backend.purgeDlq(queue);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ success: true, queue, purged }) },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_retry_completed',
    'Retry completed jobs - move them back to waiting state for reprocessing.',
    {
      queue: queueField(),
      jobId: z
        .string()
        .optional()
        .describe('Specific job ID to retry (omit to retry all completed)'),
    },
    withErrorHandler('bunqueue_retry_completed', async ({ queue, jobId }) => {
      const retried = await backend.retryCompleted(queue, jobId);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ success: true, queue, retried }) },
        ],
      };
    })
  );
}
