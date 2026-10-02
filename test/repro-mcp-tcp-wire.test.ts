/**
 * Reproduces MCP tool results that were wrong over TCP because the TcpBackend read reply
 * fields from the wrong place or ignored `ok: false` (found by the 2.9.7 MCP audit).
 * Every case runs against both backends: embedded is the control.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { jobId as toJobId } from '../src/domain/types/job';
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

/** Put `n` jobs of `queue` into the DLQ through MCP tools only; returns their ids. */
async function fillDlq(m: Mcp, queue: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const added = await m.call('bunqueue_add_job', {
      queue,
      name: `d${i}`,
      data: { i },
      attempts: 1,
    });
    ids.push(String(added.json.jobId));
    const pulled = await m.call('bunqueue_pull_job', { queue });
    await m.call('bunqueue_fail_job', {
      jobId: (pulled.json.job as { id: string }).id,
      error: 'boom',
    });
  }
  return ids;
}

for (const mode of MODES) {
  describe(`[${mode}] errors are reported, not hidden`, () => {
    test('ack/fail of missing or waiting jobs are errors', async () => {
      const m = await mcp(mode);
      expect((await m.call('bunqueue_ack_job', { jobId: 'no-such-job' })).isError).toBe(true);
      const added = await m.call('bunqueue_add_job', { queue: 'acks', name: 'n', data: {} });
      expect((await m.call('bunqueue_ack_job', { jobId: added.json.jobId })).isError).toBe(true);
      expect((await m.call('bunqueue_get_job_state', { jobId: added.json.jobId })).json.state).toBe(
        'waiting'
      );
      expect((await m.call('bunqueue_ack_job_batch', { jobIds: ['no-1', 'no-2'] })).isError).toBe(
        true
      );
      expect(
        (await m.call('bunqueue_fail_job', { jobId: 'no-such-job', error: 'x' })).isError
      ).toBe(true);
    });

    test('invalid adds are rejected instead of returning a fake id', async () => {
      const m = await mcp(mode);
      const single = await m.call('bunqueue_add_job', { queue: '', name: 'x', data: {} });
      expect(single.isError).toBe(true);
      expect(single.text).not.toContain('"undefined"');
      expect(
        (await m.call('bunqueue_add_jobs_bulk', { queue: '', jobs: [{ name: 'x', data: {} }] }))
          .isError
      ).toBe(true);
    });

    test('a webhook the broker rejects is an error', async () => {
      const m = await mcp(mode);
      const r = await m.call('bunqueue_add_webhook', {
        url: 'http://127.0.0.1:9/h',
        events: ['job.completed'],
      });
      expect(r.isError).toBe(true);
    });
  });

  describe(`[${mode}] targeted operations and counts`, () => {
    test('retry_dlq with a jobId retries only that job', async () => {
      const m = await mcp(mode);
      const [first] = await fillDlq(m, 'dlq-one', 3);
      const r = await m.call('bunqueue_retry_dlq', { queue: 'dlq-one', jobId: first });
      expect(r.json.retried).toBe(1);
      expect((await m.call('bunqueue_get_dlq', { queue: 'dlq-one' })).json.count).toBe(2);
    });

    test('drain, purge, retry_completed and batch heartbeats report real counts', async () => {
      const m = await mcp(mode);
      await m.call('bunqueue_add_jobs_bulk', {
        queue: 'drained',
        jobs: [
          { name: 'a', data: {} },
          { name: 'b', data: {} },
        ],
      });
      expect((await m.call('bunqueue_drain_queue', { queue: 'drained' })).json.removed).toBe(2);

      await fillDlq(m, 'purged', 2);
      expect((await m.call('bunqueue_purge_dlq', { queue: 'purged' })).json.purged).toBe(2);

      const done = await m.call('bunqueue_add_job', { queue: 'rerun', name: 'n', data: {} });
      await m.call('bunqueue_pull_job', { queue: 'rerun' });
      await m.call('bunqueue_ack_job', { jobId: done.json.jobId });
      expect((await m.call('bunqueue_retry_completed', { queue: 'rerun' })).json.retried).toBe(1);
      expect((await m.call('bunqueue_get_job_state', { jobId: done.json.jobId })).json.state).toBe(
        'waiting'
      );

      const beat = await m.call('bunqueue_add_job', { queue: 'beats', name: 'n', data: {} });
      await m.call('bunqueue_pull_job', { queue: 'beats' });
      expect(
        (await m.call('bunqueue_job_heartbeat_batch', { jobIds: [beat.json.jobId] })).json
          .acknowledged
      ).toBe(1);
    });

    test('wait_for_job reports a timeout as not completed', async () => {
      const m = await mcp(mode);
      const added = await m.call('bunqueue_add_job', { queue: 'waits', name: 'n', data: {} });
      const r = await m.call('bunqueue_wait_for_job', { jobId: added.json.jobId, timeoutMs: 300 });
      expect(r.json.completed).toBe(false);
    });
  });

  describe(`[${mode}] webhooks, workers and logs round-trip`, () => {
    test('webhook add, list, disable and remove use the real id', async () => {
      const m = await mcp(mode);
      const add = await m.call('bunqueue_add_webhook', {
        url: 'https://example.com/h',
        events: ['job.completed'],
      });
      expect(add.isError).toBe(false);
      const id = String(add.json.id);
      expect(id).not.toBe('0');
      expect((await m.call('bunqueue_list_webhooks')).json.webhooks).toEqual(
        expect.arrayContaining([expect.objectContaining({ id, url: 'https://example.com/h' })])
      );
      expect(
        (await m.call('bunqueue_set_webhook_enabled', { id, enabled: false })).json.success
      ).toBe(true);
      expect((await m.call('bunqueue_remove_webhook', { id })).json.success).toBe(true);
      expect((await m.call('bunqueue_list_webhooks')).json.count).toBe(0);
    });

    test('worker register, heartbeat and unregister use the returned id', async () => {
      const m = await mcp(mode);
      const reg = await m.call('bunqueue_register_worker', { name: 'w1', queues: ['wq'] });
      const id = String((reg.json.worker as { id: string }).id);
      expect(id).not.toBe('0');
      const listed = (await m.call('bunqueue_list_workers')).json.workers as Array<{ id: string }>;
      expect(listed.map((w) => w.id)).toContain(id);
      expect((await m.call('bunqueue_worker_heartbeat', { workerId: id })).json.success).toBe(true);
      expect((await m.call('bunqueue_unregister_worker', { workerId: id })).json.success).toBe(
        true
      );
      expect((await m.call('bunqueue_list_workers')).json.count).toBe(0);
    });

    test('logs are returned and keepLogs keeps the newest entries', async () => {
      const m = await mcp(mode);
      const added = await m.call('bunqueue_add_job', { queue: 'logs', name: 'n', data: {} });
      const jobId = String(added.json.jobId);
      for (const message of ['one', 'two', 'three'])
        await m.call('bunqueue_add_job_log', { jobId, message });
      const before = (await m.call('bunqueue_get_job_logs', { jobId })).json.logs as Array<{
        message: string;
      }>;
      expect(before.map((l) => l.message)).toEqual(['one', 'two', 'three']);
      await m.call('bunqueue_clear_job_logs', { jobId, keepLogs: 1 });
      const stored = m.broker
        ? (m.broker.getLogs(toJobId(jobId)) as Array<{ message: string }>)
        : ((await m.call('bunqueue_get_job_logs', { jobId })).json.logs as Array<{
            message: string;
          }>);
      expect(stored.map((l) => l.message)).toEqual(['three']);
    });
  });

  describe(`[${mode}] monitoring payloads`, () => {
    test('prometheus, memory stats and stats return real data', async () => {
      const m = await mcp(mode);
      expect((await m.call('bunqueue_get_prometheus_metrics')).text).toContain(
        '# TYPE bunqueue_jobs_waiting gauge'
      );
      const memory = (await m.call('bunqueue_get_memory_stats')).json;
      expect(typeof memory.jobIndex).toBe('number');
      expect(typeof memory.completedJobs).toBe('number');
      const stats = (await m.call('bunqueue_get_stats')).json;
      expect(Object.keys(stats)).not.toContain('reqId');
      expect(typeof stats.waiting).toBe('number');
    });
  });
}
