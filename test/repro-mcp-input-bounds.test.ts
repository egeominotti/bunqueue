/**
 * Reproduces MCP input-validation gaps found while documenting the 2.9.7 MCP audit
 * fixes: a few tools still accepted values the rest of the surface rejects (a delay
 * beyond one year, fractional or non-positive limits and indexes, an empty cron name).
 * Every case must be rejected identically in both modes, before reaching the broker.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { startMcp, type McpMode } from './mcp-harness';

type Mcp = Awaited<ReturnType<typeof startMcp>>;
const open: Mcp[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

const ONE_YEAR_PLUS = 365 * 24 * 60 * 60 * 1000 + 1;

for (const mode of ['embedded', 'tcp'] as McpMode[]) {
  describe(`[${mode}] input bounds`, () => {
    test('out-of-range arguments are rejected before anything changes', async () => {
      const m = await startMcp({ mode });
      open.push(m);
      const added = await m.call('bunqueue_add_job', { queue: 'q', name: 'n', data: {} });
      const jobId = String(added.json.jobId);

      const rejected: Array<[string, Record<string, unknown>]> = [
        ['bunqueue_move_to_delayed', { jobId, delay: ONE_YEAR_PLUS }],
        ['bunqueue_change_delay', { jobId, delay: ONE_YEAR_PLUS }],
        ['bunqueue_clean_queue', { queue: 'q', graceMs: 0, state: 'completed', limit: 0 }],
        ['bunqueue_clean_queue', { queue: 'q', graceMs: 0, state: 'completed', limit: 1.5 }],
        ['bunqueue_get_jobs', { queue: 'q', start: -1 }],
        ['bunqueue_get_jobs', { queue: 'q', end: 2.5 }],
        ['bunqueue_get_flow', { jobId, queueName: 'q', depth: 0 }],
        ['bunqueue_get_flow', { jobId, queueName: 'q', maxChildren: 1.5 }],
        ['bunqueue_get_cron', { name: '' }],
        ['bunqueue_delete_cron', { name: '' }],
      ];
      for (const [tool, args] of rejected) {
        const result = await m.call(tool, args);
        expect({ tool, args, isError: result.isError }).toEqual({ tool, args, isError: true });
      }
      expect(String((await m.call('bunqueue_get_job_state', { jobId })).json.state)).toBe(
        'waiting'
      );
    });
  });
}
