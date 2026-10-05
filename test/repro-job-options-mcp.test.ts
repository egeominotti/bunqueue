/**
 * Repro: MCP add tools and job/cron views diverged from the broker between modes.
 *
 * - The embedded MCP backend calls `QueueManager.push`/`pushBatch` directly, so it
 *   admitted a payload above the 10 MB job-data limit that the TCP backend's PUSH or
 *   PUSHB refuses, and it never ran the shared job-option validator.
 * - A legacy job or cron whose stored time lies outside the JavaScript Date range (a
 *   `timestamp` or `repeatEvery` accepted before the option bounds existed) made
 *   `toISOString` throw: `bunqueue_get_job` failed, and one such cron made
 *   `bunqueue_list_crons` fail for every schedule.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { QueueManager } from '../src/application/queueManager';
import { getSharedManager } from '../src/client/manager';
import { startMcp, type McpMode } from './mcp-harness';

type Mcp = Awaited<ReturnType<typeof startMcp>>;
const open: Mcp[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});

async function mcp(mode: McpMode): Promise<{ m: Mcp; engine: QueueManager }> {
  const m = await startMcp({ mode });
  open.push(m);
  return { m, engine: m.broker ?? getSharedManager() };
}

const TOO_LARGE = { blob: 'x'.repeat(10 * 1024 * 1024) };
/** Beyond 8.64e15, the latest instant a JavaScript Date can represent. */
const BEYOND_DATE_RANGE = 9e15;

for (const mode of ['embedded', 'tcp'] as McpMode[]) {
  describe(`[${mode}] MCP job admission and views`, () => {
    test('a payload above 10 MB is refused by add_job and add_jobs_bulk', async () => {
      const { m } = await mcp(mode);
      const single = await m.call('bunqueue_add_job', {
        queue: 'mcp-large',
        name: 'big',
        data: TOO_LARGE,
      });
      const bulk = await m.call('bunqueue_add_jobs_bulk', {
        queue: 'mcp-large',
        jobs: [
          { name: 'small', data: {} },
          { name: 'big', data: TOO_LARGE },
        ],
      });
      expect({ single: single.json.error, bulk: bulk.json.error }).toEqual({
        single: 'Job data too large (max 10MB)',
        bulk: 'jobs[1]: Job data too large (max 10MB)',
      });
      expect((await m.call('bunqueue_count_jobs', { queue: 'mcp-large' })).json.count).toBe(0);
    }, 30_000);

    test('a legacy job created outside the Date range is still readable', async () => {
      const { m, engine } = await mcp(mode);
      const legacy = await engine.push('mcp-legacy', { data: {}, timestamp: BEYOND_DATE_RANGE });
      const read = await m.call('bunqueue_get_job', { jobId: String(legacy.id) });
      expect(read.isError).toBe(false);
      expect(read.json.id).toBe(String(legacy.id));
      expect(read.json.createdAt).toBeNull();
    });

    test('a legacy cron whose next run is outside the Date range does not break listing', async () => {
      const { m, engine } = await mcp(mode);
      engine.addCron({ name: 'mcp-ok', queue: 'mcp-cron', data: {}, repeatEvery: 60_000 });
      const legacy = engine.addCron({
        name: 'mcp-legacy',
        queue: 'mcp-cron',
        data: {},
        repeatEvery: 60_000,
      });
      legacy.nextRun = BEYOND_DATE_RANGE;
      const listed = await m.call('bunqueue_list_crons');
      expect(listed.isError).toBe(false);
      const crons = listed.json.crons as Array<{ name: string; nextRun: string | null }>;
      const byName = Object.fromEntries(crons.map((cron) => [cron.name, cron.nextRun]));
      expect(byName['mcp-legacy']).toBeNull();
      expect(typeof byName['mcp-ok']).toBe('string');
    });
  });
}
