/**
 * bunqueue_get_dlq shows why a job failed (reason, error, attempt history, timestamps),
 * filters by reason and pages with offset; bunqueue_get_dlq_stats counts entries per
 * reason. Every case runs against both backends with identical expectations.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { QueueManager } from '../src/application/queueManager';
import { getSharedManager } from '../src/client/manager';
import { MAX_DLQ_ATTEMPTS_SHOWN } from '../src/mcp/backend/dlqView';
import { DLQ_FAILURE_REASONS } from '../src/mcp/tools/dlqTools';
import { startMcp, type McpMode } from './mcp-harness';

type Mcp = Awaited<ReturnType<typeof startMcp>>;
type Entry = {
  job: { id: string; name: string; state: string; attempts: number };
  reason: string;
  error: string | null;
  attempts: Array<{ attempt: number; reason: string; error: string | null; failedAt: string }>;
  attemptCount: number;
  retryCount: number;
  enteredAt: string;
  lastRetryAt: string | null;
  nextRetryAt: string | null;
  expiresAt: string | null;
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

/** The engine behind the MCP server: the broker in TCP mode, the shared manager otherwise. */
const engine = (m: Mcp): QueueManager => m.broker ?? getSharedManager();

async function pullAndFail(m: Mcp, queue: string, error: string): Promise<string> {
  const pulled = await m.call('bunqueue_pull_job', { queue });
  const id = (pulled.json.job as { id: string }).id;
  expect((await m.call('bunqueue_fail_job', { jobId: id, error })).isError).toBe(false);
  return id;
}

/** One single-attempt job failed with `error`: a max_attempts_exceeded entry. */
async function failOnce(m: Mcp, queue: string, error: string): Promise<string> {
  await m.call('bunqueue_add_job', { queue, name: 'once', data: {}, attempts: 1 });
  return pullAndFail(m, queue, error);
}

async function entries(m: Mcp, args: Record<string, unknown>) {
  const result = await m.call('bunqueue_get_dlq', args);
  expect(result.isError).toBe(false);
  return result.json as { count: number; hasMore: boolean; offset: number; entries: Entry[] };
}

for (const mode of MODES) {
  describe(`[${mode}] bunqueue_get_dlq failure details`, () => {
    test('an entry carries the thrown error, the reason and every attempt', async () => {
      const m = await mcp(mode);
      await engine(m).push('dlq-hist', {
        name: 'charge',
        data: { n: 1 },
        maxAttempts: 2,
        backoff: 0,
      });
      const id = await pullAndFail(m, 'dlq-hist', 'card declined (first)');
      expect(await pullAndFail(m, 'dlq-hist', 'card declined (second)')).toBe(id);

      const page = await entries(m, { queue: 'dlq-hist' });
      expect(page.count).toBe(1);
      expect(page.hasMore).toBe(false);
      const [entry] = page.entries;
      expect(entry.job).toMatchObject({ id, name: 'charge', state: 'failed', attempts: 2 });
      expect(entry.reason).toBe('max_attempts_exceeded');
      expect(entry.error).toBe('card declined (second)');
      expect(entry.attemptCount).toBe(2);
      expect(entry.attempts.map((a) => [a.attempt, a.reason, a.error])).toEqual([
        [1, 'explicit_fail', 'card declined (first)'],
        [2, 'max_attempts_exceeded', 'card declined (second)'],
      ]);
      expect(entry.retryCount).toBe(0);
      expect(entry.lastRetryAt).toBeNull();
      expect(entry.nextRetryAt).toBeNull();
      const entered = Date.parse(entry.enteredAt);
      expect(Math.abs(entered - Date.now())).toBeLessThan(60_000);
      // Default DLQ retention: seven days after entering.
      expect(Date.parse(entry.expiresAt ?? '')).toBe(entered + 7 * 24 * 60 * 60 * 1000);
    });

    test('a discarded job is reported with reason unknown and no error', async () => {
      const m = await mcp(mode);
      const added = await m.call('bunqueue_add_job', { queue: 'dlq-discard', name: 'n', data: {} });
      expect((await m.call('bunqueue_discard_job', { jobId: added.json.jobId })).json.success).toBe(
        true
      );
      const [entry] = (await entries(m, { queue: 'dlq-discard' })).entries;
      expect(entry.job.id).toBe(String(added.json.jobId));
      expect(entry.reason).toBe('unknown');
      expect(entry.error).toBeNull();
    });

    test('reason filter, offset paging and hasMore', async () => {
      const m = await mcp(mode);
      const q = 'dlq-pages';
      const failed = [];
      for (let i = 0; i < 3; i++) failed.push(await failOnce(m, q, `e${i}`));
      const added = await m.call('bunqueue_add_job', { queue: q, name: 'gone', data: {} });
      await m.call('bunqueue_discard_job', { jobId: added.json.jobId });

      const all = await entries(m, { queue: q });
      expect(all.count).toBe(4);
      expect(all.entries.map((e) => e.reason)).toEqual([
        'max_attempts_exceeded',
        'max_attempts_exceeded',
        'max_attempts_exceeded',
        'unknown',
      ]);

      const unknown = await entries(m, { queue: q, reason: 'unknown' });
      expect(unknown.entries.map((e) => e.job.id)).toEqual([String(added.json.jobId)]);

      const first = await entries(m, { queue: q, reason: 'max_attempts_exceeded', limit: 2 });
      expect(first.entries.map((e) => e.error)).toEqual(['e0', 'e1']);
      expect(first.hasMore).toBe(true);
      const rest = await entries(m, {
        queue: q,
        reason: 'max_attempts_exceeded',
        limit: 2,
        offset: 2,
      });
      expect(rest.offset).toBe(2);
      expect(rest.entries.map((e) => e.job.id)).toEqual([failed[2]]);
      expect(rest.hasMore).toBe(false);

      const exact = await entries(m, { queue: q, limit: 4 });
      expect(exact.count).toBe(4);
      expect(exact.hasMore).toBe(false);
      expect((await entries(m, { queue: q, offset: 3 })).entries.map((e) => e.reason)).toEqual([
        'unknown',
      ]);
      expect((await entries(m, { queue: q, reason: 'timeout' })).count).toBe(0);
    });

    test('invalid paging or reason arguments are rejected', async () => {
      const m = await mcp(mode);
      for (const args of [
        { limit: 0 },
        { limit: 101 },
        { limit: 1.5 },
        { offset: -1 },
        { reason: 'boom' },
      ]) {
        expect((await m.call('bunqueue_get_dlq', { queue: 'dlq-bad', ...args })).isError).toBe(
          true
        );
      }
    });

    test('attempt history and error texts are bounded', async () => {
      const m = await mcp(mode);
      const total = MAX_DLQ_ATTEMPTS_SHOWN + 2;
      await engine(m).push('dlq-long', { name: 'n', data: {}, maxAttempts: total, backoff: 0 });
      for (let i = 1; i <= total; i++) await pullAndFail(m, 'dlq-long', `fail ${i}`);
      const longError = 'x'.repeat(3000);
      await failOnce(m, 'dlq-long', longError);

      const [many, long] = (await entries(m, { queue: 'dlq-long' })).entries;
      expect(many.attemptCount).toBe(total);
      expect(many.attempts).toHaveLength(MAX_DLQ_ATTEMPTS_SHOWN);
      expect(many.attempts[0].attempt).toBe(total - MAX_DLQ_ATTEMPTS_SHOWN + 1);
      expect(many.attempts.at(-1)?.error).toBe(`fail ${total}`);

      expect(long.error?.startsWith('x'.repeat(1000))).toBe(true);
      expect(long.error?.length).toBeLessThan(1100);
      expect(long.error).toContain('truncated, 3000 chars');
    });
  });

  describe(`[${mode}] bunqueue_get_dlq_stats`, () => {
    test('counts entries per reason with the oldest and newest entry', async () => {
      const m = await mcp(mode);
      const q = 'dlq-stats';
      await failOnce(m, q, 'a');
      await failOnce(m, q, 'b');
      const added = await m.call('bunqueue_add_job', { queue: q, name: 'gone', data: {} });
      await m.call('bunqueue_discard_job', { jobId: added.json.jobId });

      const result = await m.call('bunqueue_get_dlq_stats', { queue: q });
      expect(result.isError).toBe(false);
      const stats = result.json as {
        queue: string;
        total: number;
        byReason: Record<string, number>;
        pendingRetry: number;
        expired: number;
        oldestEntry: string | null;
        newestEntry: string | null;
      };
      expect(stats.queue).toBe(q);
      expect(stats.total).toBe(3);
      expect(Object.keys(stats.byReason).sort()).toEqual([...DLQ_FAILURE_REASONS].sort());
      expect(stats.byReason.max_attempts_exceeded).toBe(2);
      expect(stats.byReason.unknown).toBe(1);
      expect(stats.byReason.timeout).toBe(0);
      expect(stats.pendingRetry).toBe(0);
      expect(stats.expired).toBe(0);
      expect(Date.parse(stats.oldestEntry ?? '')).toBeLessThanOrEqual(
        Date.parse(stats.newestEntry ?? '')
      );
    });

    test('an empty DLQ has no oldest or newest entry', async () => {
      const m = await mcp(mode);
      const stats = (await m.call('bunqueue_get_dlq_stats', { queue: 'dlq-none' })).json;
      expect(stats).toMatchObject({ total: 0, oldestEntry: null, newestEntry: null });
    });
  });
}
