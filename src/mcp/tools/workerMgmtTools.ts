/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Worker Management
 * Register, unregister, heartbeat workers
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import { queueField } from './schemas';
import { withErrorHandler } from './withErrorHandler';

export function registerWorkerMgmtTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_register_worker',
    'Register a new worker to process jobs from specified queues.',
    {
      name: z.string().describe('Worker name/identifier'),
      queues: z.array(queueField()).min(1).describe('Queues this worker will process'),
    },
    withErrorHandler('bunqueue_register_worker', async ({ name, queues }) => {
      const worker = await backend.registerWorker(name, queues);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ success: true, worker }, null, 2) },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_unregister_worker',
    'Unregister a worker, removing it from the active workers list.',
    {
      workerId: z.string().describe('Worker ID to unregister'),
    },
    withErrorHandler('bunqueue_unregister_worker', async ({ workerId }) => {
      const success = await backend.unregisterWorker(workerId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, workerId }) }] };
    })
  );

  server.tool(
    'bunqueue_worker_heartbeat',
    'Send a heartbeat to keep a registered worker alive.',
    {
      workerId: z.string().describe('Worker ID'),
    },
    withErrorHandler('bunqueue_worker_heartbeat', async ({ workerId }) => {
      const success = await backend.workerHeartbeat(workerId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, workerId }) }] };
    })
  );
}
