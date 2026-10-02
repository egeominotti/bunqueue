/* eslint-disable @typescript-eslint/no-deprecated, @typescript-eslint/require-await */
/**
 * MCP Tools - HTTP Handler Management
 * Register, unregister, list HTTP handlers that auto-process jobs.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HttpHandlerRegistry } from '../httpHandler';
import { queueField } from './schemas';
import { withErrorHandler } from './withErrorHandler';

export function registerHandlerTools(server: McpServer, registry: HttpHandlerRegistry) {
  server.tool(
    'bunqueue_register_handler',
    'Register an HTTP handler on a queue. Spawns a worker that auto-processes jobs by making HTTP requests. Combine with bunqueue_add_cron for recurring tasks.',
    {
      queue: queueField('Queue name to attach the handler to'),
      url: z.string().url().describe('HTTP endpoint URL to call when a job is processed'),
      method: z
        .enum(['GET', 'POST', 'PUT', 'DELETE'])
        .describe('HTTP method (GET, POST, PUT, DELETE)'),
      headers: z.record(z.string(), z.string()).optional().describe('Custom HTTP headers'),
      body: z
        .unknown()
        .optional()
        .describe('Request body template for POST/PUT (defaults to job data)'),
      timeoutMs: z
        .number()
        .min(1000)
        .max(120000)
        .optional()
        .describe('Request timeout in ms (default: 30000)'),
    },
    withErrorHandler(
      'bunqueue_register_handler',
      async ({ queue, url, method, headers, body, timeoutMs }) => {
        registry.register(queue, { url, method, headers, body, timeoutMs });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  queue,
                  handler: { url, method, timeoutMs: timeoutMs ?? 30000 },
                  message: `Worker started. Jobs in "${queue}" will be processed via ${method} ${url}`,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    )
  );

  server.tool(
    'bunqueue_unregister_handler',
    'Remove an HTTP handler from a queue and stop its worker.',
    {
      queue: queueField('Queue name to remove the handler from'),
    },
    withErrorHandler('bunqueue_unregister_handler', async ({ queue }) => {
      const removed = registry.unregister(queue);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: removed, queue }),
          },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_list_handlers',
    'List all active HTTP handlers and their workers.',
    {},
    withErrorHandler('bunqueue_list_handlers', async () => {
      const handlers = registry.list();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ count: handlers.length, handlers }, null, 2),
          },
        ],
      };
    })
  );
}
