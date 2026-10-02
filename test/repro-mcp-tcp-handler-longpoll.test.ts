/**
 * Reproduces two TCP-mode MCP failures (found by the 2.9.7 MCP audit):
 * - HTTP handlers always ran an embedded worker, so jobs on the remote broker were
 *   never processed;
 * - a long-poll pull at the schema maximum (30 s) hit the client's 30 s command
 *   timeout and returned an error instead of an empty result.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { startMcp, type McpMode } from './mcp-harness';

type Mcp = Awaited<ReturnType<typeof startMcp>>;
const open: Mcp[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});
async function mcp(mode: McpMode) {
  const m = await startMcp({ mode });
  open.push(m);
  return m;
}

for (const mode of ['embedded', 'tcp'] as McpMode[]) {
  describe(`[${mode}] HTTP handler`, () => {
    test('processes a job added through MCP', async () => {
      const m = await mcp(mode);
      let hits = 0;
      const http = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: () => {
          hits++;
          return Response.json({ ok: true });
        },
      });
      try {
        await m.call('bunqueue_register_handler', {
          queue: 'hooks',
          url: `http://127.0.0.1:${http.port}/x`,
          method: 'POST',
        });
        const added = await m.call('bunqueue_add_job', {
          queue: 'hooks',
          name: 'n',
          data: { v: 1 },
        });
        let state = '';
        for (let i = 0; i < 50 && state !== 'completed'; i++) {
          await Bun.sleep(100);
          state = String(
            (await m.call('bunqueue_get_job_state', { jobId: added.json.jobId })).json.state
          );
        }
        expect(state).toBe('completed');
        expect(hits).toBe(1);
      } finally {
        await m.call('bunqueue_unregister_handler', { queue: 'hooks' });
        http.stop(true);
      }
    }, 15_000);
  });
}

describe('[tcp] long-poll at the schema maximum', () => {
  test('pull_job with timeoutMs 30000 on an empty queue returns no job, not an error', async () => {
    const m = await mcp('tcp');
    const r = await m.call('bunqueue_pull_job', { queue: 'empty', timeoutMs: 30_000 });
    expect(r.isError).toBe(false);
    expect(r.json.job).toBeNull();
  }, 45_000);
});
