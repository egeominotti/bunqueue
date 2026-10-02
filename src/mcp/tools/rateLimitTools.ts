/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Rate Limiting & Concurrency Control
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import { queueField } from './schemas';
import { withErrorHandler } from './withErrorHandler';

/** Longest rate-limit window accepted (one year), like the job delay bound. */
const MAX_RATE_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_RATE_WINDOW_MS = 1000;

/** A limit the broker can enforce exactly: a positive whole number of jobs. */
function limitField(description: string) {
  return z.number().int().min(1).describe(description);
}

export function registerRateLimitTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_set_rate_limit',
    'Set the rate limit of a queue: at most `limit` jobs start per `duration` ms (default 1000 ms, i.e. per second). It is a token bucket that refills continuously, so an idle queue can start up to `limit` jobs at once. Replaces any previous rate limit; read it back with bunqueue_get_queue_limits.',
    {
      queue: queueField(),
      limit: limitField('Max jobs started per window (a positive integer)'),
      duration: z
        .number()
        .int()
        .min(1)
        .max(MAX_RATE_WINDOW_MS)
        .optional()
        .describe('Window length in ms (default: 1000; e.g. 60000 = limit per minute)'),
    },
    withErrorHandler('bunqueue_set_rate_limit', async ({ queue, limit, duration }) => {
      await backend.setRateLimit(queue, limit, duration);
      const durationMs = duration ?? DEFAULT_RATE_WINDOW_MS;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, queue, rateLimit: limit, durationMs }),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_clear_rate_limit',
    'Remove rate limit from a queue, allowing unlimited throughput.',
    {
      queue: queueField(),
    },
    withErrorHandler('bunqueue_clear_rate_limit', async ({ queue }) => {
      await backend.clearRateLimit(queue);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, queue, message: 'Rate limit cleared' }),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_set_concurrency',
    'Set the concurrency limit of a queue: at most `limit` of its jobs are active at once across all workers; a pull beyond it gets nothing until a job finishes.',
    {
      queue: queueField(),
      limit: limitField('Max concurrent active jobs (a positive integer)'),
    },
    withErrorHandler('bunqueue_set_concurrency', async ({ queue, limit }) => {
      await backend.setConcurrency(queue, limit);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, queue, concurrency: limit }),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_clear_concurrency',
    'Remove concurrency limit from a queue.',
    {
      queue: queueField(),
    },
    withErrorHandler('bunqueue_clear_concurrency', async ({ queue }) => {
      await backend.clearConcurrency(queue);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, queue, message: 'Concurrency limit cleared' }),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_get_queue_limits',
    'Read the limits of a queue and whether they are holding jobs back: rateLimit ({ max, durationMs } or null), rateLimitTtlMs (ms until the rate limit admits the next job, or until a temporary limit set by a client expires; null without a rate limit), rateLimited, concurrencyLimit (or null), active (jobs running now), concurrencyMaxed (no free slot: the next pull gets nothing) and paused.',
    {
      queue: queueField(),
    },
    withErrorHandler('bunqueue_get_queue_limits', async ({ queue }) => {
      const limits = await backend.getQueueLimits(queue);
      return { content: [{ type: 'text' as const, text: JSON.stringify(limits, null, 2) }] };
    })
  );
}
