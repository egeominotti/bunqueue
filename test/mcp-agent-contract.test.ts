import { afterEach, describe, expect, test } from 'bun:test';
import { DecisionModel } from '../src/mcp/decisionModel';
import { fakeDecisionServer, startMcp, type McpMode } from './mcp-harness';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function harness(mode: McpMode, env: Record<string, string> = {}) {
  const mcp = await startMcp({ mode, env });
  cleanups.push(mcp.close);
  return mcp;
}

for (const mode of ['embedded', 'tcp'] as const) {
  describe(`agent contract (${mode})`, () => {
    test('keeps legacy text while exposing success, missing targets and not-applied outcomes', async () => {
      const mcp = await harness(mode);
      const added = await mcp.client.callTool({
        name: 'bunqueue_add_job',
        arguments: { queue: 'contract', name: 'job', data: {} },
      });
      const legacy = JSON.parse((added.content as Array<{ text: string }>)[0].text);
      expect(added.structuredContent).toEqual({ outcome: 'success', data: legacy });
      const missing = await mcp.client.callTool({
        name: 'bunqueue_get_job',
        arguments: { jobId: 'missing-contract' },
      });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent).toMatchObject({
        outcome: 'error',
        error: { code: 'not_found', retryable: false },
        data: { error: 'Job not found' },
      });
      const rejected = await mcp.client.callTool({
        name: 'bunqueue_promote_job',
        arguments: { jobId: legacy.jobId },
      });
      expect(rejected.isError).not.toBe(true);
      expect(rejected.structuredContent).toMatchObject({
        outcome: 'not_applied',
        data: { success: false, jobId: legacy.jobId },
        error: { code: 'rejected_transition', retryable: false },
      });
      const metrics = await mcp.client.callTool({
        name: 'bunqueue_get_prometheus_metrics',
        arguments: {},
      });
      expect(metrics.structuredContent).toMatchObject({
        outcome: 'success',
        data: { text: expect.any(String) },
      });
      expect((await mcp.backend.getJobCounts('contract')).waiting).toBe(1);
    });

    test('guard previews require approval and dynamic calls preserve a single envelope', async () => {
      const mcp = await harness(mode, { BUNQUEUE_MCP_PROFILE: 'agent' });
      const loaded = await mcp.client.callTool({
        name: 'bunqueue_enable_toolsets',
        arguments: { toolsets: ['jobs', 'queues'] },
      });
      expect(loaded.structuredContent).toMatchObject({
        outcome: 'success',
        data: { enabled: ['jobs', 'queues'] },
      });
      const descriptors = JSON.parse((loaded.content as Array<{ text: string }>)[0].text).tools;
      for (const descriptor of descriptors) {
        expect(descriptor.annotations).toBeDefined();
        expect(descriptor.outputSchema.properties.outcome.enum).toContain('confirmation_required');
      }
      await mcp.call('bunqueue_add_job', { queue: 'guarded-contract', name: 'job', data: {} });
      const preview = await mcp.client.callTool({
        name: 'bunqueue_call_tool',
        arguments: { name: 'bunqueue_obliterate_queue', arguments: { queue: 'guarded-contract' } },
      });
      expect(preview.isError).toBe(true);
      expect(preview.structuredContent).toMatchObject({
        outcome: 'confirmation_required',
        data: { executed: false, impact: expect.any(String) },
        error: { code: 'confirmation_required', retryable: false },
      });
      expect((await mcp.backend.getJobCounts('guarded-contract')).waiting).toBe(1);
      const approved = await mcp.client.callTool({
        name: 'bunqueue_call_tool',
        arguments: {
          name: 'bunqueue_obliterate_queue',
          arguments: { queue: 'guarded-contract', confirm: 'guarded-contract' },
        },
      });
      expect(approved.structuredContent).toMatchObject({
        outcome: 'success',
        data: { success: true },
      });
      expect((approved.structuredContent as { data: object }).data).not.toHaveProperty('outcome');
      expect((await mcp.backend.getJobCounts('guarded-contract')).waiting).toBe(0);
    });

    test('capabilities reports configured features and cannot expose credentials', async () => {
      const mcp = await harness(mode, { BUNQUEUE_TOKEN: 'never-display-token' });
      const result = await mcp.client.callTool({
        name: 'bunqueue_get_capabilities',
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        outcome: 'success',
        data: { mode, profile: 'default', confirmation: false, workflows: { configured: false } },
      });
      expect(JSON.stringify(result)).not.toContain('never-display-token');
      expect(
        (result.structuredContent as { data: { toolsets: string[] } }).data.toolsets
      ).toContain('monitoring');
    });

    test('direct invalid arguments remain SDK errors before the normalized handler', async () => {
      const mcp = await harness(mode);
      const added = await mcp.call('bunqueue_add_job', {
        queue: 'direct-invalid',
        name: 'job',
        data: {},
      });
      const jobId = String(added.json.jobId);
      for (const progress of [101, 'wrong-type']) {
        const result = await mcp.client.callTool({
          name: 'bunqueue_update_progress',
          arguments: { jobId, progress },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect((result.content as Array<{ text: string }>)[0].text).toContain(
          'Input validation error'
        );
      }
      expect((await mcp.backend.getJob(jobId))?.progress).toBe(0);
      expect((await mcp.backend.getJobCounts('direct-invalid')).waiting).toBe(1);
    });
  });
}

test('profile overrides are explicit and do not mutate the caller environment', async () => {
  const env = {
    BUNQUEUE_MCP_PROFILE: 'agent',
    BUNQUEUE_MCP_TOOLSETS: 'all',
    BUNQUEUE_MCP_CONFIRM: 'off',
  };
  const mcp = await harness('embedded', env);
  expect(await mcp.toolNames()).toHaveLength(79);
  await mcp.call('bunqueue_add_job', { queue: 'override', name: 'job', data: {} });
  expect((await mcp.call('bunqueue_obliterate_queue', { queue: 'override' })).isError).toBe(false);
  expect(env).toEqual({
    BUNQUEUE_MCP_PROFILE: 'agent',
    BUNQUEUE_MCP_TOOLSETS: 'all',
    BUNQUEUE_MCP_CONFIRM: 'off',
  });
});

test('elicitation decline is a cancellation and does not execute the operation', async () => {
  const mcp = await startMcp({
    env: { BUNQUEUE_MCP_CONFIRM: 'destructive' },
    elicit: () => ({ action: 'decline' }),
  });
  cleanups.push(mcp.close);
  await mcp.call('bunqueue_add_job', { queue: 'declined', name: 'job', data: {} });
  const result = await mcp.client.callTool({
    name: 'bunqueue_obliterate_queue',
    arguments: { queue: 'declined' },
  });
  expect(result.structuredContent).toMatchObject({
    outcome: 'not_applied',
    error: { code: 'cancelled', retryable: false },
    data: { executed: false },
  });
  expect((await mcp.backend.getJobCounts('declined')).waiting).toBe(1);
});

test('a closed TCP connection distinguishes safe read retry from an uncertain write', async () => {
  const mcp = await harness('tcp');
  mcp.backend.shutdown();
  const read = await mcp.client.callTool({ name: 'bunqueue_get_stats', arguments: {} });
  expect(read.structuredContent).toMatchObject({
    outcome: 'error',
    error: { code: 'backend_unavailable', retryable: true },
  });
  const write = await mcp.client.callTool({
    name: 'bunqueue_add_job',
    arguments: { queue: 'uncertain', name: 'job', data: {} },
  });
  expect(write.structuredContent).toMatchObject({
    outcome: 'error',
    error: { code: 'backend_unavailable', retryable: false, outcomeUncertain: true },
  });
  expect((write.structuredContent as { suggestedAction: string }).suggestedAction).toContain(
    'reconcile'
  );
  expect(mcp.broker?.getQueueJobCounts('uncertain').waiting).toBe(0);
});

test('dynamic dispatch input errors have structured invalid-input classifications', async () => {
  const mcp = await harness('embedded', { BUNQUEUE_MCP_TOOLSETS: 'dynamic,jobs' });
  const result = await mcp.client.callTool({
    name: 'bunqueue_call_tool',
    arguments: { name: 'bunqueue_add_job', arguments: { queue: 'invalid' } },
  });
  expect(result.structuredContent).toMatchObject({
    outcome: 'error',
    error: { code: 'invalid_input', retryable: false },
  });
  expect((await mcp.backend.getJobCounts('invalid')).waiting).toBe(0);
});

test('decision-provider failure remains discoverable without claiming operational success', async () => {
  const fake = fakeDecisionServer(() => new Response('offline provider failure', { status: 400 }));
  cleanups.push(fake.stop);
  const decision = new DecisionModel({
    provider: 'systemone',
    model: 'offline-test',
    url: fake.url,
    timeoutMs: 1000,
  });
  const mcp = await startMcp({ env: { BUNQUEUE_MCP_TOOLSETS: 'dynamic' }, decision });
  cleanups.push(mcp.close);
  const result = await mcp.client.callTool({
    name: 'bunqueue_find_tools',
    arguments: { request: 'Inspect queue health' },
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    outcome: 'error',
    error: { code: 'provider_unavailable', retryable: true },
  });
  expect((result.structuredContent as { suggestedAction: string }).suggestedAction).toContain(
    'bunqueue_enable_toolsets'
  );
  expect(await mcp.toolNames()).toContain('bunqueue_enable_toolsets');
});
