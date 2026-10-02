/**
 * BUNQUEUE_MCP_CONFIRM=destructive against a real embedded broker: guarded tools never
 * act without a confirmation, the user's answer (elicitation) is authoritative, and a
 * decision model can only block when the client cannot ask the user.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { DecisionModel } from '../src/mcp/decisionModel';
import { fakeDecisionServer, startMcp } from './mcp-harness';

const CONFIRM = { BUNQUEUE_MCP_CONFIRM: 'destructive' };
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function mcp(options: Parameters<typeof startMcp>[0] = {}) {
  const m = await startMcp({ ...options, env: { ...CONFIRM, ...options.env } });
  cleanups.push(m.close);
  return m;
}

async function seed(m: Awaited<ReturnType<typeof startMcp>>, queue: string, n = 3) {
  for (let i = 0; i < n; i++)
    await m.call('bunqueue_add_job', { queue, name: `job-${i}`, data: { i } });
}

const waiting = async (m: Awaited<ReturnType<typeof startMcp>>, queue: string) =>
  (await m.backend.getJobCounts(queue)).waiting;

describe('without elicitation: explicit target confirmation', () => {
  test('refuses, explains the impact and keeps the data', async () => {
    const m = await mcp();
    await seed(m, 'billing');
    const result = await m.call('bunqueue_obliterate_queue', { queue: 'billing' });
    expect(result.isError).toBe(true);
    expect(result.json.executed).toBe(false);
    expect(String(result.json.impact)).toContain('3 waiting');
    expect(String(result.json.howToConfirm)).toContain('confirm: "billing"');
    expect(await waiting(m, 'billing')).toBe(3);
  });

  test('the impact of a paused queue counts its paused jobs', async () => {
    const m = await mcp();
    await seed(m, 'billing');
    await m.call('bunqueue_pause_queue', { queue: 'billing' });
    for (const tool of ['bunqueue_drain_queue', 'bunqueue_obliterate_queue']) {
      const result = await m.call(tool, { queue: 'billing' });
      expect(result.isError).toBe(true);
      expect(String(result.json.impact)).toContain('3 paused');
    }
    await m.call('bunqueue_drain_queue', { queue: 'billing', confirm: 'billing' });
    expect((await m.backend.getJobCounts('billing')).paused).toBe(0);
  });

  test('the purge impact gives the exact dead letter count, beyond any preview page', async () => {
    const m = await mcp();
    const jobs = Array.from({ length: 1005 }, (_, i) => ({ name: 'n', data: { i } }));
    const { jobIds } = await m.backend.addJobsBulk('mail', jobs);
    for (const id of jobIds) await m.backend.discardJob(id);
    const result = await m.call('bunqueue_purge_dlq', { queue: 'mail' });
    expect(result.isError).toBe(true);
    expect(String(result.json.impact)).toContain('delete 1005 dead letter entries');
  });

  test('refusals of a non-destructive guarded tool do not call it destructive', async () => {
    const m = await mcp();
    const result = await m.call('bunqueue_retry_completed', { queue: 'billing' });
    expect(result.isError).toBe(true);
    expect(String(result.json.error)).toBe('Confirmation required for this operation.');
  });

  test('refuses a confirmation that names another target', async () => {
    const m = await mcp();
    await seed(m, 'billing');
    const result = await m.call('bunqueue_drain_queue', {
      queue: 'billing',
      confirm: 'billing-old',
    });
    expect(result.isError).toBe(true);
    expect(await waiting(m, 'billing')).toBe(3);
  });

  test('runs with the exact target', async () => {
    const m = await mcp();
    await seed(m, 'billing');
    const result = await m.call('bunqueue_drain_queue', { queue: 'billing', confirm: 'billing' });
    expect(result.isError).toBe(false);
    expect(result.json.removed).toBe(3);
    expect(await waiting(m, 'billing')).toBe(0);
  });

  test('guards job-level deletes by job id', async () => {
    const m = await mcp();
    const added = await m.call('bunqueue_add_job', { queue: 'jobs', name: 'invoice', data: {} });
    const jobId = String(added.json.jobId);
    const refused = await m.call('bunqueue_cancel_job', { jobId });
    expect(refused.isError).toBe(true);
    expect(String(refused.json.impact)).toContain('"invoice"');
    expect(await m.backend.getJob(jobId)).not.toBeNull();
    const done = await m.call('bunqueue_cancel_job', { jobId, confirm: jobId });
    expect(done.isError).toBe(false);
    expect(await m.backend.getJob(jobId)).toBeNull();
  });

  test('discard is not guarded: the job moves to the DLQ and can be retried', async () => {
    const m = await mcp();
    const added = await m.call('bunqueue_add_job', { queue: 'jobs', name: 'invoice', data: {} });
    const jobId = String(added.json.jobId);
    expect((await m.call('bunqueue_discard_job', { jobId })).isError).toBe(false);
    expect((await m.backend.getDlq('jobs', 10)).map((j) => j.id)).toContain(jobId);
  });

  test('retry_completed is guarded only for the bulk form', async () => {
    const m = await mcp();
    await seed(m, 'done', 1);
    const pulled = await m.call('bunqueue_pull_job', { queue: 'done' });
    const jobId = String((pulled.json.job as { id: string } | undefined)?.id ?? pulled.json.id);
    await m.call('bunqueue_ack_job', { jobId });
    const single = await m.call('bunqueue_retry_completed', { queue: 'done', jobId });
    expect(single.isError).toBe(false);
    const bulk = await m.call('bunqueue_retry_completed', { queue: 'done' });
    expect(bulk.isError).toBe(true);
    expect(String(bulk.json.impact)).toContain('happens again');
  });

  test('non-guarded tools are annotated but unchanged', async () => {
    const m = await mcp();
    const result = await m.call('bunqueue_pause_queue', { queue: 'free' });
    expect(result.isError).toBe(false);
    const tool = (await m.client.listTools()).tools.find((t) => t.name === 'bunqueue_pause_queue');
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });
});

describe('with elicitation: the user decides', () => {
  test('accept runs the operation and shows the impact', async () => {
    const m = await mcp({ elicit: () => ({ action: 'accept', content: { confirm: true } }) });
    await seed(m, 'mail');
    const result = await m.call('bunqueue_obliterate_queue', { queue: 'mail' });
    expect(result.isError).toBe(false);
    expect(m.prompts[0]).toContain('3 waiting');
    expect(await waiting(m, 'mail')).toBe(0);
  });

  test('decline wins even when the agent passed the right confirm', async () => {
    const m = await mcp({ elicit: () => ({ action: 'decline' }) });
    await seed(m, 'mail');
    const result = await m.call('bunqueue_obliterate_queue', { queue: 'mail', confirm: 'mail' });
    expect(result.isError).toBe(true);
    expect(await waiting(m, 'mail')).toBe(3);
  });

  test('accepting without ticking confirm counts as a decline', async () => {
    const m = await mcp({ elicit: () => ({ action: 'accept', content: { confirm: false } }) });
    await seed(m, 'mail');
    expect((await m.call('bunqueue_purge_dlq', { queue: 'mail' })).isError).toBe(true);
    expect((await m.call('bunqueue_drain_queue', { queue: 'mail' })).isError).toBe(true);
    expect(await waiting(m, 'mail')).toBe(3);
  });
});

describe('with a decision model and no elicitation', () => {
  function modelSaying(noul: number | 'fail') {
    const fake = fakeDecisionServer(() =>
      noul === 'fail'
        ? new Response('boom', { status: 500 })
        : { answers: { check: { type: 'noul', noul } } }
    );
    cleanups.push(fake.stop);
    return {
      fake,
      decision: new DecisionModel({
        provider: 'systemone',
        model: 'jev-latest',
        url: fake.url,
        timeoutMs: 2000,
      }),
    };
  }

  test('adds userRequest to guarded tools only', async () => {
    const { decision } = modelSaying(0.99);
    const m = await mcp({ decision });
    const tools = (await m.client.listTools()).tools;
    const props = (name: string) => {
      const schema = tools.find((t) => t.name === name)?.inputSchema as
        | { properties?: object }
        | undefined;
      return Object.keys(schema?.properties ?? {});
    };
    expect(props('bunqueue_drain_queue')).toEqual(
      expect.arrayContaining(['confirm', 'userRequest'])
    );
    expect(props('bunqueue_pause_queue')).not.toContain('userRequest');
  });

  test('requires the user request', async () => {
    const { decision, fake } = modelSaying(0.99);
    const m = await mcp({ decision });
    await seed(m, 'ops');
    const result = await m.call('bunqueue_drain_queue', { queue: 'ops', confirm: 'ops' });
    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect(await waiting(m, 'ops')).toBe(3);
  });

  test('blocks an ambiguous request', async () => {
    const { decision, fake } = modelSaying(0.3);
    const m = await mcp({ decision });
    await seed(m, 'ops');
    const result = await m.call('bunqueue_obliterate_queue', {
      queue: 'ops',
      confirm: 'ops',
      userRequest: 'tidy up the ops queue a bit',
    });
    expect(result.isError).toBe(true);
    expect(result.json.probability).toBe(0.3);
    expect(await waiting(m, 'ops')).toBe(3);
    const sent = fake.calls[0].body as { state: { userRequest: string; operation: string } };
    expect(sent.state.userRequest).toBe('tidy up the ops queue a bit');
    expect(sent.state.operation).toContain('Permanently delete queue "ops"');
  });

  test('allows an explicit request', async () => {
    const { decision } = modelSaying(0.97);
    const m = await mcp({ decision });
    await seed(m, 'ops');
    const result = await m.call('bunqueue_obliterate_queue', {
      queue: 'ops',
      confirm: 'ops',
      userRequest: 'delete the ops queue completely, all of its jobs',
    });
    expect(result.isError).toBe(false);
    expect(await waiting(m, 'ops')).toBe(0);
  });

  test('fails closed when the model is unavailable', async () => {
    const { decision, fake } = modelSaying('fail');
    const m = await mcp({ decision });
    await seed(m, 'ops');
    const result = await m.call('bunqueue_drain_queue', {
      queue: 'ops',
      confirm: 'ops',
      userRequest: 'drain ops',
    });
    expect(result.isError).toBe(true);
    expect(String(result.json.cause)).toContain('HTTP 500');
    expect(fake.calls).toHaveLength(2);
    expect(await waiting(m, 'ops')).toBe(3);
  });

  test('the model is not consulted when the user answered through the client', async () => {
    const { decision, fake } = modelSaying(0.01);
    const m = await mcp({
      decision,
      elicit: () => ({ action: 'accept', content: { confirm: true } }),
    });
    await seed(m, 'ops');
    expect((await m.call('bunqueue_drain_queue', { queue: 'ops' })).isError).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});
