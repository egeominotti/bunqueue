/**
 * bunqueue_get_queue_limits reads what the broker enforces (rate limit and its window,
 * concurrency limit, active count, maxed/rate-limited, paused), and bunqueue_set_rate_limit
 * honors its `duration` window. Limits the broker cannot enforce exactly (fractional,
 * zero, negative) are rejected. Every case runs against both backends.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { startMcp, type McpMode } from './mcp-harness';

type Mcp = Awaited<ReturnType<typeof startMcp>>;
type Limits = {
  queue: string;
  paused: boolean;
  rateLimit: { max: number; durationMs: number } | null;
  rateLimitTtlMs: number | null;
  rateLimited: boolean;
  concurrencyLimit: number | null;
  active: number;
  concurrencyMaxed: boolean;
};

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

async function limits(m: Mcp, queue: string): Promise<Limits> {
  const result = await m.call('bunqueue_get_queue_limits', { queue });
  expect(result.isError).toBe(false);
  return result.json as Limits;
}

async function addJobs(m: Mcp, queue: string, n: number) {
  const jobs = Array.from({ length: n }, (_, i) => ({ name: `j${i}`, data: { i } }));
  expect((await m.call('bunqueue_add_jobs_bulk', { queue, jobs })).isError).toBe(false);
}

async function pull(m: Mcp, queue: string): Promise<string | null> {
  const job = (await m.call('bunqueue_pull_job', { queue })).json.job as { id: string } | null;
  return job?.id ?? null;
}

for (const mode of MODES) {
  describe(`[${mode}] bunqueue_get_queue_limits`, () => {
    test('a queue without limits', async () => {
      const m = await mcp(mode);
      expect(await limits(m, 'plain')).toEqual({
        queue: 'plain',
        paused: false,
        rateLimit: null,
        rateLimitTtlMs: null,
        rateLimited: false,
        concurrencyLimit: null,
        active: 0,
        concurrencyMaxed: false,
      });
    });

    test('a rate limit with a window is reported and enforced, then cleared', async () => {
      const m = await mcp(mode);
      const q = 'rated';
      const set = await m.call('bunqueue_set_rate_limit', { queue: q, limit: 2, duration: 60_000 });
      expect(set.json).toEqual({ success: true, queue: q, rateLimit: 2, durationMs: 60_000 });
      const fresh = await limits(m, q);
      expect(fresh.rateLimit).toEqual({ max: 2, durationMs: 60_000 });
      expect(fresh.rateLimitTtlMs).toBe(0);
      expect(fresh.rateLimited).toBe(false);

      await addJobs(m, q, 3);
      expect(await pull(m, q)).not.toBeNull();
      expect(await pull(m, q)).not.toBeNull();
      const drained = await limits(m, q);
      expect(drained.rateLimited).toBe(true);
      // Two jobs per 60 s refill one token every 30 s; the default 1 s window would be 500 ms.
      expect(drained.rateLimitTtlMs).toBeGreaterThan(20_000);
      expect(drained.rateLimitTtlMs).toBeLessThanOrEqual(30_000);
      expect(drained.active).toBe(2);
      expect(await pull(m, q)).toBeNull();

      await m.call('bunqueue_clear_rate_limit', { queue: q });
      const cleared = await limits(m, q);
      expect(cleared.rateLimit).toBeNull();
      expect(cleared.rateLimitTtlMs).toBeNull();
      expect(cleared.rateLimited).toBe(false);
      expect(await pull(m, q)).not.toBeNull();
    });

    test('without duration the window is one second', async () => {
      const m = await mcp(mode);
      const set = await m.call('bunqueue_set_rate_limit', { queue: 'per-second', limit: 5 });
      expect(set.json.durationMs).toBe(1000);
      expect((await limits(m, 'per-second')).rateLimit).toEqual({ max: 5, durationMs: 1000 });
    });

    test('concurrency limit, active count and maxed follow pulls and acks', async () => {
      const m = await mcp(mode);
      const q = 'bounded';
      await m.call('bunqueue_set_concurrency', { queue: q, limit: 2 });
      await addJobs(m, q, 3);
      expect(await limits(m, q)).toMatchObject({
        concurrencyLimit: 2,
        active: 0,
        concurrencyMaxed: false,
      });

      const first = await pull(m, q);
      expect(await limits(m, q)).toMatchObject({ active: 1, concurrencyMaxed: false });
      expect(await pull(m, q)).not.toBeNull();
      expect(await limits(m, q)).toMatchObject({ active: 2, concurrencyMaxed: true });
      expect(await pull(m, q)).toBeNull();

      expect((await m.call('bunqueue_ack_job', { jobId: first })).isError).toBe(false);
      expect(await limits(m, q)).toMatchObject({ active: 1, concurrencyMaxed: false });

      await m.call('bunqueue_clear_concurrency', { queue: q });
      expect(await limits(m, q)).toMatchObject({
        concurrencyLimit: null,
        active: 1,
        concurrencyMaxed: false,
      });
    });

    test('paused is reported', async () => {
      const m = await mcp(mode);
      await m.call('bunqueue_pause_queue', { queue: 'held' });
      expect((await limits(m, 'held')).paused).toBe(true);
      await m.call('bunqueue_resume_queue', { queue: 'held' });
      expect((await limits(m, 'held')).paused).toBe(false);
    });

    test('limits the broker cannot enforce exactly are rejected and not applied', async () => {
      const m = await mcp(mode);
      const q = 'strict';
      for (const args of [
        { limit: 1.5 },
        { limit: 0 },
        { limit: -1 },
        { limit: 2, duration: 0 },
        { limit: 2, duration: 1.5 },
        { limit: 2, duration: -1000 },
      ]) {
        expect((await m.call('bunqueue_set_rate_limit', { queue: q, ...args })).isError).toBe(true);
      }
      for (const limit of [1.5, 0, -2]) {
        expect((await m.call('bunqueue_set_concurrency', { queue: q, limit })).isError).toBe(true);
      }
      expect(await limits(m, q)).toMatchObject({ rateLimit: null, concurrencyLimit: null });
    });
  });
}
