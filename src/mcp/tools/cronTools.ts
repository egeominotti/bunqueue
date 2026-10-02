/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Cron Job Management
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import { cronOptionsShape, toCronInput } from './cronOptions';
import { queueField } from './schemas';
import { withErrorHandler } from './withErrorHandler';

export function registerCronTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_add_cron',
    'Add a recurring schedule that adds a job to a queue on a cron pattern (schedule, optionally in a time zone) or every repeatEvery ms. Adding an existing name replaces that schedule and keeps its run count. By default (preventOverlap) at most one job of the schedule is pending: a run adds nothing while the previous job is still waiting, delayed or active. Returns the schedule with its next run time.',
    {
      name: z.string().min(1).describe('Unique schedule name'),
      queue: queueField('Target queue name'),
      data: z.record(z.string(), z.unknown()).describe('Payload of every job the schedule adds'),
      schedule: z
        .string()
        .optional()
        .describe(
          'Cron pattern: 5 fields (minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5"), 6 with leading seconds, or a shortcut such as "@hourly"'
        ),
      repeatEvery: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Alternative to schedule: run every N milliseconds'),
      ...cronOptionsShape(),
    },
    withErrorHandler('bunqueue_add_cron', async (args) => {
      const cron = await backend.addCron(toCronInput(args));
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ success: true, ...cron }, null, 2) },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_list_crons',
    'List all schedules: name, queue, schedule or repeatEvery, time zone, job name, priority, run limit, runs so far and next run time.',
    {},
    withErrorHandler('bunqueue_list_crons', async () => {
      const crons = await backend.listCrons();
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ count: crons.length, crons }, null, 2) },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_get_cron',
    'Get one schedule by name: queue, schedule or repeatEvery, time zone, job name, priority, run limit (maxLimit), runs so far (executions) and next run time.',
    {
      name: z.string().min(1).describe('Cron job name'),
    },
    withErrorHandler('bunqueue_get_cron', async ({ name }) => {
      const cron = await backend.getCron(name);
      if (!cron) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: 'Cron not found', name }) },
          ],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(cron, null, 2) }] };
    })
  );

  server.tool(
    'bunqueue_delete_cron',
    'Delete a cron job by name.',
    {
      name: z.string().min(1).describe('Cron job name to delete'),
    },
    withErrorHandler('bunqueue_delete_cron', async ({ name }) => {
      const success = await backend.deleteCron(name);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, name }) }] };
    })
  );
}
