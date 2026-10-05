/**
 * Full job options on the MCP add tools (bunqueue_add_job, bunqueue_add_jobs_bulk and the
 * flow tools' opts): every option is honored end to end, reported back on the job, and
 * rejected identically by both backends. Every case runs embedded and over TCP.
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

/** Polls `check` until it is true or `timeoutMs` elapses; returns the last outcome. */
async function eventually(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(50);
  }
  return check();
}

async function add(m: Mcp, args: Record<string, unknown>) {
  const r = await m.call('bunqueue_add_job', { name: 'job', data: {}, ...args });
  expect(r.isError).toBe(false);
  return String(r.json.jobId);
}
const state = async (m: Mcp, jobId: string) =>
  (await m.call('bunqueue_get_job_state', { jobId })).json.state;
const pulled = async (m: Mcp, queue: string) =>
  (await m.call('bunqueue_pull_job', { queue })).json.job as Record<string, unknown> | null;

for (const mode of MODES) {
  describe(`[${mode}] custom job id`, () => {
    test('a second add with the same jobId returns the same job and adds nothing', async () => {
      const m = await mcp(mode);
      expect(await add(m, { queue: 'ids-a', jobId: 'order-1', data: { v: 1 } })).toBe('order-1');
      // Ids are server-wide: the same id in another queue is still the first job.
      expect(await add(m, { queue: 'ids-b', jobId: 'order-1', data: { v: 2 } })).toBe('order-1');
      expect((await m.call('bunqueue_count_jobs', { queue: 'ids-a' })).json.count).toBe(1);
      expect((await m.call('bunqueue_count_jobs', { queue: 'ids-b' })).json.count).toBe(0);

      const byCustom = await m.call('bunqueue_get_job_by_custom_id', { customId: 'order-1' });
      expect(byCustom.isError).toBe(false);
      expect(byCustom.json).toMatchObject({ id: 'order-1', queue: 'ids-a', data: { v: 1 } });
      expect(byCustom.json.state).toBe('waiting');
    });

    test('a finished id is released: lookup misses, get_job still finds it, re-add reuses it', async () => {
      const m = await mcp(mode);
      await add(m, { queue: 'ids-done', jobId: 'done-1' });
      await pulled(m, 'ids-done');
      await m.call('bunqueue_ack_job', { jobId: 'done-1' });
      expect((await m.call('bunqueue_get_job_by_custom_id', { customId: 'done-1' })).isError).toBe(
        true
      );
      expect((await m.call('bunqueue_get_job', { jobId: 'done-1' })).json.state).toBe('completed');

      expect(await add(m, { queue: 'ids-done', jobId: 'done-1', data: { again: true } })).toBe(
        'done-1'
      );
      const reused = await m.call('bunqueue_get_job', { jobId: 'done-1' });
      expect(reused.json).toMatchObject({ state: 'waiting', data: { again: true } });

      // A DLQ'd id is reused too, and the new job replaces the DLQ entry.
      await add(m, { queue: 'ids-dlq', jobId: 'dead-1', attempts: 1 });
      await pulled(m, 'ids-dlq');
      await m.call('bunqueue_fail_job', { jobId: 'dead-1', error: 'boom' });
      expect(await state(m, 'dead-1')).toBe('failed');
      expect(await add(m, { queue: 'ids-dlq', jobId: 'dead-1' })).toBe('dead-1');
      expect(await state(m, 'dead-1')).toBe('waiting');
      expect((await m.call('bunqueue_get_dlq', { queue: 'ids-dlq' })).json.count).toBe(0);
    });
  });

  describe(`[${mode}] deduplication`, () => {
    test('a taken key returns the owner; replace swaps the pending job; keys are per queue', async () => {
      const m = await mcp(mode);
      const first = await add(m, { queue: 'dd', data: { v: 1 }, deduplication: { id: 'k' } });
      expect(await add(m, { queue: 'dd', data: { v: 2 }, deduplication: { id: 'k' } })).toBe(first);
      const job = await m.call('bunqueue_get_job', { jobId: first });
      expect(job.json).toMatchObject({ data: { v: 1 }, deduplicationId: 'k' });

      const replaced = await add(m, {
        queue: 'dd',
        data: { v: 3 },
        deduplication: { id: 'k', replace: true },
      });
      expect(replaced).not.toBe(first);
      expect(await state(m, first)).toBe('unknown');
      expect((await m.call('bunqueue_get_job', { jobId: replaced })).json.data).toEqual({ v: 3 });
      expect((await m.call('bunqueue_count_jobs', { queue: 'dd' })).json.count).toBe(1);

      expect(await add(m, { queue: 'dd-other', deduplication: { id: 'k' } })).not.toBe(replaced);

      // An active owner: a plain duplicate returns it, extend is refused, replace adds a successor.
      const active = await add(m, { queue: 'dd-act', deduplication: { id: 'a', ttl: 60_000 } });
      await pulled(m, 'dd-act');
      expect(await add(m, { queue: 'dd-act', deduplication: { id: 'a' } })).toBe(active);
      const extendActive = await m.call('bunqueue_add_job', {
        queue: 'dd-act',
        name: 'job',
        data: {},
        deduplication: { id: 'a', ttl: 60_000, extend: true },
      });
      expect(extendActive.json.error).toBe('Duplicate unique_key (extended TTL)');
      const successor = await add(m, {
        queue: 'dd-act',
        deduplication: { id: 'a', replace: true },
      });
      expect(successor).not.toBe(active);
      expect(await state(m, active)).toBe('active');
      // Completion releases a key even before its ttl ends.
      await m.call('bunqueue_ack_job', { jobId: active });
      await pulled(m, 'dd-act');
      await m.call('bunqueue_ack_job', { jobId: successor });
      expect(await add(m, { queue: 'dd-act', deduplication: { id: 'a', ttl: 60_000 } })).not.toBe(
        successor
      );

      const ttl = { id: 'e', ttl: 60_000 };
      const owner = await add(m, { queue: 'dd-ext', deduplication: ttl });
      expect(await add(m, { queue: 'dd-ext', deduplication: { ...ttl, extend: true } })).toBe(
        owner
      );
    });
  });

  describe(`[${mode}] retries, timeout and removal`, () => {
    test('attempts and backoff are reported and honored before the retry', async () => {
      const m = await mcp(mode);
      const id = await add(m, {
        queue: 'retry',
        attempts: 2,
        backoff: { type: 'fixed', delay: 600 },
      });
      const job = await m.call('bunqueue_get_job', { jobId: id });
      expect(job.json).toMatchObject({ maxAttempts: 2, backoff: { type: 'fixed', delay: 600 } });

      await pulled(m, 'retry');
      const failedAt = Date.now();
      await m.call('bunqueue_fail_job', { jobId: id, error: 'first' });
      expect(await state(m, id)).toBe('delayed');
      expect(await pulled(m, 'retry')).toBeNull();
      let retried: Record<string, unknown> | null = null;
      expect(
        await eventually(async () => (retried = await pulled(m, 'retry')) !== null, 3000)
      ).toBe(true);
      // Fixed backoff waits delay × 0.8–1.2 (480–720 ms).
      expect(Date.now() - failedAt).toBeGreaterThanOrEqual(450);
      expect(retried).toMatchObject({ id, attempts: 1 });

      await m.call('bunqueue_fail_job', { jobId: id, error: 'second' });
      expect(await state(m, id)).toBe('failed');

      const numeric = await add(m, { queue: 'retry-n', backoff: 250 });
      expect((await m.call('bunqueue_get_job', { jobId: numeric })).json.backoff).toBe(250);
    });

    test('an active job past its timeout fails', async () => {
      const m = await mcp(mode);
      const id = await add(m, { queue: 'timeout', timeout: 300, attempts: 1 });
      expect((await m.call('bunqueue_get_job', { jobId: id })).json.timeout).toBe(300);
      await pulled(m, 'timeout');
      expect(await eventually(async () => (await state(m, id)) === 'failed', 3000)).toBe(true);
    });

    test('removeOnComplete and removeOnFail delete the finished job', async () => {
      const m = await mcp(mode);
      const done = await add(m, { queue: 'rm', removeOnComplete: true });
      expect((await m.call('bunqueue_get_job', { jobId: done })).json.removeOnComplete).toBe(true);
      await pulled(m, 'rm');
      expect((await m.call('bunqueue_ack_job', { jobId: done })).isError).toBe(false);
      expect((await m.call('bunqueue_get_job', { jobId: done })).isError).toBe(true);
      expect(await state(m, done)).toBe('unknown');

      const lost = await add(m, { queue: 'rm', removeOnFail: true, attempts: 1 });
      await pulled(m, 'rm');
      await m.call('bunqueue_fail_job', { jobId: lost, error: 'x' });
      expect(await state(m, lost)).toBe('unknown');
      expect((await m.call('bunqueue_get_dlq', { queue: 'rm' })).json.count).toBe(0);
    });
  });

  describe(`[${mode}] ordering and storage options`, () => {
    test('lifo jobs run before older jobs of the same priority, newest first', async () => {
      const m = await mcp(mode);
      await add(m, { queue: 'lifo', name: 'fifo' });
      for (const name of ['a', 'b', 'c']) {
        await add(m, { queue: 'lifo', name, lifo: true });
        await Bun.sleep(2);
      }
      const order: unknown[] = [];
      for (let i = 0; i < 4; i++) order.push((await pulled(m, 'lifo'))?.name);
      expect(order).toEqual(['c', 'b', 'a', 'fifo']);
    });

    test('durable, tags and stallTimeout are accepted and reported', async () => {
      const m = await mcp(mode);
      const id = await add(m, {
        queue: 'store',
        durable: true,
        tags: ['t1', 't2'],
        stallTimeout: 60_000,
      });
      const job = await m.call('bunqueue_get_job', { jobId: id });
      expect(job.json).toMatchObject({
        state: 'waiting',
        tags: ['t1', 't2'],
        stallTimeout: 60_000,
      });
    });

    test('bulk jobs take the same options per job', async () => {
      const m = await mcp(mode);
      const r = await m.call('bunqueue_add_jobs_bulk', {
        queue: 'bulk',
        jobs: [
          { name: 'a', data: {}, jobId: 'bulk-1', attempts: 5, backoff: 100, durable: true },
          { name: 'b', data: {}, jobId: 'bulk-1' },
          { name: 'c', data: {}, deduplication: { id: 'z' }, lifo: true, timeout: 1000 },
          { name: 'd', data: {}, deduplication: { id: 'z' } },
        ],
      });
      const ids = r.json.jobIds as string[];
      expect(ids[0]).toBe('bulk-1');
      expect(ids[1]).toBe('bulk-1');
      expect(ids[3]).toBe(ids[2]);
      expect((await m.call('bunqueue_count_jobs', { queue: 'bulk' })).json.count).toBe(2);
      const first = await m.call('bunqueue_get_job', { jobId: 'bulk-1' });
      expect(first.json).toMatchObject({ name: 'a', maxAttempts: 5, backoff: 100 });
      const third = await m.call('bunqueue_get_job', { jobId: ids[2] });
      expect(third.json).toMatchObject({ lifo: true, timeout: 1000, deduplicationId: 'z' });
    });
  });
}

/** Calls the backend never sees: zod (or the flow planner) rejects them in both modes. */
const INVALID: Array<[string, Record<string, unknown>]> = [
  ['bunqueue_add_job', { priority: 1.5 }],
  ['bunqueue_add_job', { priority: 2_000_000 }],
  // A negative delay is accepted: the job is ready at once (repro-job-options-negative-delay).
  ['bunqueue_add_job', { delay: 365 * 86_400_000 + 1 }],
  ['bunqueue_add_job', { attempts: 0 }],
  ['bunqueue_add_job', { attempts: 1001 }],
  ['bunqueue_add_job', { backoff: -1 }],
  ['bunqueue_add_job', { backoff: 86_400_001 }],
  ['bunqueue_add_job', { backoff: { type: 'linear', delay: 100 } }],
  ['bunqueue_add_job', { backoff: { type: 'fixed' } }],
  ['bunqueue_add_job', { timeout: 86_400_001 }],
  ['bunqueue_add_job', { stallTimeout: -5 }],
  ['bunqueue_add_job', { jobId: '' }],
  ['bunqueue_add_job', { jobId: 'a\ud800b' }],
  ['bunqueue_add_job', { deduplication: { id: '' } }],
  ['bunqueue_add_job', { deduplication: { id: 'k', extend: true } }],
  ['bunqueue_add_job', { deduplication: { id: 'k', ttl: 0 } }],
  ['bunqueue_add_job', { tags: ['x'.repeat(257)] }],
  ['bunqueue_add_job', { removeOnComplete: 'yes' }],
  ['bunqueue_add_jobs_bulk', { jobs: [{ name: 'a', data: {}, attempts: 0 }] }],
  ['bunqueue_add_flow', { opts: { deduplication: { id: 'k' } } }],
  ['bunqueue_add_flow', { opts: { tags: ['t'] } }],
  ['bunqueue_add_flow', { opts: { durable: true } }],
  ['bunqueue_add_flow', { opts: { timeout: -1 } }],
  ['bunqueue_add_flow', { opts: { jobId: 'a:b' } }],
];

function invalidArgs(tool: string, extra: Record<string, unknown>): Record<string, unknown> {
  if (tool === 'bunqueue_add_job') return { queue: 'invalid', name: 'n', data: {}, ...extra };
  if (tool === 'bunqueue_add_jobs_bulk') return { queue: 'invalid', ...extra };
  return { name: 'n', queueName: 'invalid', ...extra };
}

describe('invalid options', () => {
  test('are rejected identically by both backends and add nothing', async () => {
    const texts: Record<McpMode, string[]> = { embedded: [], tcp: [] };
    for (const mode of MODES) {
      const m = await startMcp({ mode });
      try {
        for (const [tool, extra] of INVALID) {
          const r = await m.call(tool, invalidArgs(tool, extra));
          expect(r.isError, `${mode} ${tool} ${JSON.stringify(extra)}`).toBe(true);
          texts[mode].push(r.text);
        }
        expect((await m.call('bunqueue_count_jobs', { queue: 'invalid' })).json.count).toBe(0);
      } finally {
        await m.close();
      }
    }
    expect(texts.tcp).toEqual(texts.embedded);
  });
});
