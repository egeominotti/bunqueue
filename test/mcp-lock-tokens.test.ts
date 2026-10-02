/**
 * Lock tokens for manual processing through MCP: a pull with an `owner` locks the job and
 * returns its token, which ack / fail / heartbeat / extend_lock then use. A missing or
 * wrong token on a locked job is an error carrying the broker's message in both modes;
 * pulls without an owner behave exactly as before (no token). Every case runs embedded
 * and over TCP.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { startMcp, type McpMode } from './mcp-harness';

type Mcp = Awaited<ReturnType<typeof startMcp>>;
type PulledJob = Record<string, unknown> & { id: string; token?: string };
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

async function addJobs(m: Mcp, queue: string, n: number, extra: Record<string, unknown> = {}) {
  for (let i = 0; i < n; i++) {
    await m.call('bunqueue_add_job', { queue, name: `j${i}`, data: { i }, ...extra });
  }
}
async function pullLocked(m: Mcp, queue: string, lockTtl?: number): Promise<PulledJob> {
  const r = await m.call('bunqueue_pull_job', {
    queue,
    owner: 'agent',
    ...(lockTtl ? { lockTtl } : {}),
  });
  expect(r.isError).toBe(false);
  return r.json.job as PulledJob;
}
const state = async (m: Mcp, jobId: string) =>
  (await m.call('bunqueue_get_job_state', { jobId })).json.state;

for (const mode of MODES) {
  describe(`[${mode}] pulls without an owner are unchanged`, () => {
    test('no token is returned and ack/heartbeat need none', async () => {
      const m = await mcp(mode);
      await addJobs(m, 'plain', 3);
      const single = (await m.call('bunqueue_pull_job', { queue: 'plain' })).json.job as PulledJob;
      expect('token' in single).toBe(false);
      const batch = (await m.call('bunqueue_pull_job_batch', { queue: 'plain', count: 2 })).json
        .jobs as PulledJob[];
      expect(batch.some((job) => 'token' in job)).toBe(false);

      expect((await m.call('bunqueue_job_heartbeat', { jobId: single.id })).json.success).toBe(
        true
      );
      expect((await m.call('bunqueue_ack_job', { jobId: single.id })).isError).toBe(false);
      const ids = batch.map((job) => job.id);
      expect((await m.call('bunqueue_ack_job_batch', { jobIds: ids })).isError).toBe(false);
      expect(await state(m, ids[1])).toBe('completed');
    });

    test('lockTtl without owner and out-of-range lock values are rejected', async () => {
      const m = await mcp(mode);
      await addJobs(m, 'bad-lock', 1);
      const alone = await m.call('bunqueue_pull_job', { queue: 'bad-lock', lockTtl: 5000 });
      expect(alone).toMatchObject({ isError: true, json: { error: 'lockTtl requires owner' } });
      const batch = await m.call('bunqueue_pull_job_batch', {
        queue: 'bad-lock',
        count: 1,
        lockTtl: 5000,
      });
      expect(batch.json.error).toBe('lockTtl requires owner');
      const short = await m.call('bunqueue_pull_job', {
        queue: 'bad-lock',
        owner: 'a',
        lockTtl: 500,
      });
      expect(short.isError).toBe(true);
      expect((await m.call('bunqueue_count_jobs', { queue: 'bad-lock' })).json.count).toBe(1);
    });
  });

  describe(`[${mode}] a locked job needs its token`, () => {
    test('ack fails without or with a wrong token and succeeds with the right one', async () => {
      const m = await mcp(mode);
      await addJobs(m, 'lock-ack', 1);
      const job = await pullLocked(m, 'lock-ack');
      expect(typeof job.token).toBe('string');
      expect(job.state).toBe('active');

      const none = await m.call('bunqueue_ack_job', { jobId: job.id });
      expect(none).toMatchObject({
        isError: true,
        json: { error: `Lock token required for job ${job.id}` },
      });
      const wrong = await m.call('bunqueue_ack_job', { jobId: job.id, token: 'not-the-token' });
      expect(wrong.json.error).toBe(`Invalid or expired lock token for job ${job.id}`);
      expect(await state(m, job.id)).toBe('active');

      // The lock also guards the job-control tools that have no token parameter.
      const moved = await m.call('bunqueue_move_to_delayed', { jobId: job.id, delay: 1000 });
      expect(moved.json.error).toBe(`Lock token required for job ${job.id}`);

      const ok = await m.call('bunqueue_ack_job', {
        jobId: job.id,
        token: job.token,
        result: { r: 1 },
      });
      expect(ok.isError).toBe(false);
      expect(await state(m, job.id)).toBe('completed');
      expect((await m.call('bunqueue_get_job_result', { jobId: job.id })).json.result).toEqual({
        r: 1,
      });
    });

    test('heartbeat and extend_lock accept only the right token', async () => {
      const m = await mcp(mode);
      await addJobs(m, 'lock-renew', 1);
      const job = await pullLocked(m, 'lock-renew', 5000);
      const beat = (token?: string) => m.call('bunqueue_job_heartbeat', { jobId: job.id, token });
      expect((await beat(job.token)).json.success).toBe(true);
      expect((await beat('wrong')).json.success).toBe(false);

      const extend = (token: string, duration: number) =>
        m.call('bunqueue_extend_lock', { jobId: job.id, token, duration });
      expect((await extend(job.token as string, 60_000)).json.success).toBe(true);
      expect((await extend('wrong', 60_000)).json.success).toBe(false);
      expect((await extend(job.token as string, 500)).isError).toBe(true);
      expect(await state(m, job.id)).toBe('active');
    });

    test('fail needs the token; unrecoverable skips the remaining attempts', async () => {
      const m = await mcp(mode);
      await addJobs(m, 'lock-fail', 2);
      const retried = await pullLocked(m, 'lock-fail');
      const none = await m.call('bunqueue_fail_job', { jobId: retried.id, error: 'x' });
      expect(none.json.error).toBe(`Lock token required for job ${retried.id}`);
      expect(await state(m, retried.id)).toBe('active');
      const failed = await m.call('bunqueue_fail_job', {
        jobId: retried.id,
        error: 'x',
        token: retried.token,
      });
      expect(failed.isError).toBe(false);
      expect(await state(m, retried.id)).toBe('delayed');

      const fatal = await pullLocked(m, 'lock-fail');
      const r = await m.call('bunqueue_fail_job', {
        jobId: fatal.id,
        error: 'fatal',
        token: fatal.token,
        unrecoverable: true,
      });
      expect(r.isError).toBe(false);
      expect(await state(m, fatal.id)).toBe('failed');
      expect((await m.call('bunqueue_get_dlq', { queue: 'lock-fail' })).json.count).toBe(1);
    });
  });

  describe(`[${mode}] batch variants`, () => {
    test('a locked batch is acked only with every token, aligned with the ids', async () => {
      const m = await mcp(mode);
      await addJobs(m, 'lock-batch', 3);
      const r = await m.call('bunqueue_pull_job_batch', {
        queue: 'lock-batch',
        count: 3,
        owner: 'agent',
      });
      const jobs = r.json.jobs as PulledJob[];
      expect(jobs).toHaveLength(3);
      const ids = jobs.map((job) => job.id);
      const tokens = jobs.map((job) => job.token as string);
      expect(new Set(tokens).size).toBe(3);

      const ack = (args: Record<string, unknown>) =>
        m.call('bunqueue_ack_job_batch', { jobIds: ids, ...args });
      expect((await ack({})).json.error).toBe(`Lock token required for job ${ids[0]}`);
      expect((await ack({ tokens: tokens.slice(1) })).json.error).toBe(
        'tokens must have exactly one entry per jobId'
      );
      const oneWrong = await ack({ tokens: [tokens[0], 'wrong', tokens[2]] });
      expect(oneWrong.json.error).toBe(`Invalid or expired lock token for job ${ids[1]}`);
      for (const id of ids) expect(await state(m, id)).toBe('active');

      const beats = (list: string[]) =>
        m.call('bunqueue_job_heartbeat_batch', { jobIds: ids, tokens: list });
      expect((await beats(tokens)).json.acknowledged).toBe(3);
      expect((await beats(['a', 'b', 'c'])).json.acknowledged).toBe(0);
      expect((await beats(['a'])).json.error).toBe('tokens must have exactly one entry per jobId');

      expect((await ack({ tokens })).isError).toBe(false);
      for (const id of ids) expect(await state(m, id)).toBe('completed');
    });

    test('an empty token stands for a job pulled without an owner', async () => {
      const m = await mcp(mode);
      await addJobs(m, 'lock-mixed', 2);
      const plain = (await m.call('bunqueue_pull_job', { queue: 'lock-mixed' })).json
        .job as PulledJob;
      const locked = await pullLocked(m, 'lock-mixed');
      const r = await m.call('bunqueue_ack_job_batch', {
        jobIds: [plain.id, locked.id],
        tokens: ['', locked.token],
      });
      expect(r.isError).toBe(false);
      expect(await state(m, plain.id)).toBe('completed');
      expect(await state(m, locked.id)).toBe('completed');
    });
  });

  describe(`[${mode}] lock expiry`, () => {
    test('an unrenewed lock expires and the job is requeued; a token-less heartbeat does not renew it', async () => {
      const m = await mcp(mode);
      await addJobs(m, 'lock-expiry', 3);
      const r = await m.call('bunqueue_pull_job_batch', {
        queue: 'lock-expiry',
        count: 3,
        owner: 'agent',
        lockTtl: 1000,
      });
      const [kept, dropped, untokened] = r.json.jobs as PulledJob[];
      const extended = await m.call('bunqueue_extend_lock', {
        jobId: kept.id,
        token: kept.token,
        duration: 60_000,
      });
      expect(extended.json.success).toBe(true);
      const plainBeat = await m.call('bunqueue_job_heartbeat', { jobId: untokened.id });
      expect(plainBeat.json.success).toBe(true);

      const deadline = Date.now() + 9000;
      while (Date.now() < deadline) {
        if (
          (await state(m, dropped.id)) !== 'active' &&
          (await state(m, untokened.id)) !== 'active'
        )
          break;
        await Bun.sleep(100);
      }
      expect(await state(m, dropped.id)).toBe('waiting');
      expect(await state(m, untokened.id)).toBe('waiting');
      expect((await m.call('bunqueue_get_job', { jobId: dropped.id })).json.attempts).toBe(1);
      expect(await state(m, kept.id)).toBe('active');
      expect(
        (await m.call('bunqueue_ack_job', { jobId: kept.id, token: kept.token })).isError
      ).toBe(false);
    }, 20_000);
  });
}
