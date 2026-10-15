/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Resources
 * Read-only data resources for AI context
 */

import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from './adapter';
import { boundedRows, boundedValue, MAX_SUMMARY_ROWS } from './inspectionBounds';
import { diagnoseQueue } from './diagnostics';
import { INSPECTION_STATES, listJobsPage } from './inspectionPage';

function withResourceErrorHandler(
  uri: string,
  fn: () => Promise<{ contents: Array<{ uri: string; text: string; mimeType: string }> }>
) {
  return async () => {
    try {
      return await fn();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        contents: [
          {
            uri,
            text: JSON.stringify({ error: boundedValue(message).value, isError: true }),
            mimeType: 'application/json',
          },
        ],
      };
    }
  };
}

export function registerResources(server: McpServer, backend: McpBackend) {
  // Global stats resource
  server.resource(
    'stats',
    'bunqueue://stats',
    { description: 'Overall queue server statistics', mimeType: 'application/json' },
    withResourceErrorHandler('bunqueue://stats', async () => {
      const stats = await backend.getStats();
      const projection = boundedValue(stats);
      return {
        contents: [
          {
            uri: 'bunqueue://stats',
            text: JSON.stringify(
              projection.truncated ? { stats: projection.value, truncated: true } : projection.value
            ),
            mimeType: 'application/json',
          },
        ],
      };
    })
  );

  // Queues list resource
  server.resource(
    'queues',
    'bunqueue://queues',
    { description: 'All queues with job counts per state', mimeType: 'application/json' },
    withResourceErrorHandler('bunqueue://queues', async () => {
      const queues = await backend.listQueues();
      const details = await Promise.all(
        queues.slice(0, MAX_SUMMARY_ROWS).map(async (q) => {
          const counts = await backend.getJobCounts(q);
          return { name: q, ...counts };
        })
      );
      return {
        contents: [
          {
            uri: 'bunqueue://queues',
            text: JSON.stringify(boundedRows(details, undefined, queues.length)),
            mimeType: 'application/json',
          },
        ],
      };
    })
  );

  // Cron jobs resource
  server.resource(
    'crons',
    'bunqueue://crons',
    { description: 'All scheduled cron jobs', mimeType: 'application/json' },
    withResourceErrorHandler('bunqueue://crons', async () => {
      const crons = await backend.listCrons();
      return {
        contents: [
          {
            uri: 'bunqueue://crons',
            text: JSON.stringify(boundedRows(crons)),
            mimeType: 'application/json',
          },
        ],
      };
    })
  );

  // Workers resource
  server.resource(
    'workers',
    'bunqueue://workers',
    { description: 'Active workers and their status', mimeType: 'application/json' },
    withResourceErrorHandler('bunqueue://workers', async () => {
      const workers = await backend.listWorkers();
      return {
        contents: [
          {
            uri: 'bunqueue://workers',
            text: JSON.stringify(boundedRows(workers)),
            mimeType: 'application/json',
          },
        ],
      };
    })
  );

  // Webhooks resource
  server.resource(
    'webhooks',
    'bunqueue://webhooks',
    { description: 'Registered webhooks', mimeType: 'application/json' },
    withResourceErrorHandler('bunqueue://webhooks', async () => {
      const webhooks = await backend.listWebhooks();
      return {
        contents: [
          {
            uri: 'bunqueue://webhooks',
            text: JSON.stringify(boundedRows(webhooks)),
            mimeType: 'application/json',
          },
        ],
      };
    })
  );

  server.resource(
    'queue-diagnosis',
    new ResourceTemplate('bunqueue://queue/{queue}', { list: undefined }),
    {
      description: 'Scoped read-only queue diagnosis with bounded safe samples',
      mimeType: 'application/json',
    },
    async (uri, variables) =>
      withResourceErrorHandler(uri.href, async () => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(await diagnoseQueue(backend, scopedQueue(variables.queue))),
          },
        ],
      }))()
  );
  server.resource(
    'queue-jobs-page',
    new ResourceTemplate('bunqueue://queue/{queue}/jobs/{state}/{offset}/{limit}', {
      list: undefined,
    }),
    {
      description: 'Scoped safe job page; state all or a supported job state; limit 1..100',
      mimeType: 'application/json',
    },
    async (uri, variables) =>
      withResourceErrorHandler(uri.href, async () => {
        const state = String(variables.state);
        const offset = Number(variables.offset);
        const limit = Number(variables.limit);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > Number.MAX_SAFE_INTEGER - 101 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          (state !== 'all' && !INSPECTION_STATES.some((s) => s === state))
        ) {
          throw new Error('Invalid queue page parameters');
        }
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(
                await listJobsPage(backend, {
                  queue: scopedQueue(variables.queue),
                  state: state === 'all' ? undefined : state,
                  offset,
                  limit,
                })
              ),
            },
          ],
        };
      })()
  );
}

function scopedQueue(value: string | string[]) {
  if (typeof value !== 'string') throw new Error('Invalid queue name');
  const decoded = decodeURIComponent(value);
  if (!decoded || decoded.length > 1024) {
    throw new Error('Invalid queue name');
  }
  return decoded;
}
