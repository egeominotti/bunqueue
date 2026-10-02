/**
 * Reproduces MCP tools whose behavior contradicted their own description, in one or
 * both backends (found by the 2.9.7 MCP audit). Every case runs against both backends.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { startMcp, type McpMode } from './mcp-harness';

type Mcp = Awaited<ReturnType<typeof startMcp>>;
const MODES: McpMode[] = ['embedded', 'tcp'];
const open: Mcp[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
});
async function mcp(mode: McpMode) {
  const m = await startMcp({ mode });
  open.push(m);
  return m;
}

/** Add a job, pull it and ack it; returns its id. */
async function complete(m: Mcp, queue: string, name = 'n'): Promise<string> {
  const added = await m.call('bunqueue_add_job', { queue, name, data: {}, priority: 9 });
  const pulled = await m.call('bunqueue_pull_job', { queue });
  await m.call('bunqueue_ack_job', { jobId: (pulled.json.job as { id: string }).id });
  return String(added.json.jobId);
}

for (const mode of MODES) {
  describe(`[${mode}] tools do what their description says`, () => {
    test('clean_queue without state removes completed and failed jobs and keeps waiting ones', async () => {
      const m = await mcp(mode);
      const keep = await m.call('bunqueue_add_job', { queue: 'clean', name: 'keep', data: {} });
      await complete(m, 'clean', 'done');
      const failed = await m.call('bunqueue_add_job', {
        queue: 'clean',
        name: 'f',
        data: {},
        priority: 9,
        attempts: 1,
      });
      await m.call('bunqueue_pull_job', { queue: 'clean' });
      await m.call('bunqueue_fail_job', { jobId: failed.json.jobId });
      await Bun.sleep(20);
      await m.call('bunqueue_clean_queue', { queue: 'clean', graceMs: 0 });
      expect((await m.call('bunqueue_get_job_state', { jobId: keep.json.jobId })).json.state).toBe(
        'waiting'
      );
      const counts = (await m.call('bunqueue_get_job_counts', { queue: 'clean' })).json;
      expect({ completed: counts.completed, failed: counts.failed }).toEqual({
        completed: 0,
        failed: 0,
      });
    });

    test('count_jobs counts jobs in every state', async () => {
      const m = await mcp(mode);
      await m.call('bunqueue_add_jobs_bulk', {
        queue: 'counted',
        jobs: [
          { name: 'a', data: {} },
          { name: 'b', data: {} },
          { name: 'c', data: {} },
        ],
      });
      const pulled = await m.call('bunqueue_pull_job', { queue: 'counted' });
      await m.call('bunqueue_ack_job', { jobId: (pulled.json.job as { id: string }).id });
      await m.call('bunqueue_pull_job', { queue: 'counted' });
      expect((await m.call('bunqueue_count_jobs', { queue: 'counted' })).json.count).toBe(3);
    });

    test('a paused queue reports its ready jobs only under paused', async () => {
      const m = await mcp(mode);
      await m.call('bunqueue_add_job', { queue: 'held', name: 'w', data: {} });
      await m.call('bunqueue_add_job', { queue: 'held', name: 'p', data: {}, priority: 5 });
      await m.call('bunqueue_pause_queue', { queue: 'held' });
      for (const tool of ['bunqueue_get_job_counts', 'bunqueue_get_queue_stats']) {
        const r = (await m.call(tool, { queue: 'held' })).json;
        expect({ waiting: r.waiting, prioritized: r.prioritized, paused: r.paused }).toEqual({
          waiting: 0,
          prioritized: 0,
          paused: 2,
        });
      }
    });

    test('wait_for_job returns at once for a job that already completed', async () => {
      const m = await mcp(mode);
      const jobId = await complete(m, 'waited');
      const started = Date.now();
      const r = await m.call('bunqueue_wait_for_job', { jobId, timeoutMs: 2000 });
      expect(r.json.completed).toBe(true);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    test('get_job includes the job state', async () => {
      const m = await mcp(mode);
      const added = await m.call('bunqueue_add_job', {
        queue: 'stated',
        name: 'n',
        data: {},
        delay: 60_000,
      });
      expect((await m.call('bunqueue_get_job', { jobId: added.json.jobId })).json.state).toBe(
        'delayed'
      );
    });

    test('a waiting job with a priority can be listed by state', async () => {
      const m = await mcp(mode);
      const added = await m.call('bunqueue_add_job', {
        queue: 'ranked',
        name: 'n',
        data: {},
        priority: 2,
      });
      const ids: string[] = [];
      for (const state of ['waiting', 'prioritized']) {
        const r = await m.call('bunqueue_get_jobs', { queue: 'ranked', state });
        ids.push(...((r.json.jobs as Array<{ id: string }> | undefined) ?? []).map((j) => j.id));
      }
      expect(ids).toContain(String(added.json.jobId));
    });

    test('get_progress reads the progress of a completed job', async () => {
      const m = await mcp(mode);
      const added = await m.call('bunqueue_add_job', { queue: 'progress', name: 'n', data: {} });
      await m.call('bunqueue_pull_job', { queue: 'progress' });
      await m.call('bunqueue_update_progress', {
        jobId: added.json.jobId,
        progress: 100,
        message: 'done',
      });
      await m.call('bunqueue_ack_job', { jobId: added.json.jobId });
      const r = await m.call('bunqueue_get_progress', { jobId: added.json.jobId });
      expect(r.isError).toBe(false);
      expect(r.json.progress).toBe(100);
    });
  });
}
