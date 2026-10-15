import { expect, test } from 'bun:test';
import { startMcp } from './mcp-harness';

test('an invalid broker reply after PUSH preserves the admitted job and reports uncertainty', async () => {
  const m = await startMcp({ mode: 'tcp' });
  try {
    const add = m.backend.addJob.bind(m.backend);
    m.backend.addJob = async (...args) => {
      await add(...args);
      throw new Error('Invalid PUSH response from broker: missing job id');
    };
    const result = await m.client.callTool({
      name: 'bunqueue_add_job',
      arguments: { queue: 'uncertain-push', name: 'task', data: {} },
    });
    expect((await m.backend.getJobCounts('uncertain-push')).waiting).toBe(1);
    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as {
      outcome: string;
      error: { code: string; retryable: boolean; outcomeUncertain?: boolean };
      suggestedAction: string;
    };
    expect(envelope.outcome).toBe('error');
    expect(envelope.error.code).not.toBe('invalid_input');
    expect(envelope.error.retryable).toBe(false);
    expect(envelope.error.outcomeUncertain).toBe(true);
    expect(envelope.suggestedAction).toContain('reconcile');
  } finally {
    await m.close();
  }
});

test('a dispatcher refusal before loading a write tool reports definite non-execution', async () => {
  const m = await startMcp({ env: { BUNQUEUE_MCP_TOOLSETS: 'dynamic' } });
  try {
    const result = await m.client.callTool({
      name: 'bunqueue_call_tool',
      arguments: {
        name: 'bunqueue_add_job',
        arguments: { queue: 'not-dispatched', name: 'task', data: {} },
      },
    });
    expect((await m.backend.getJobCounts('not-dispatched')).waiting).toBe(0);
    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as {
      error: { retryable: boolean; outcomeUncertain?: boolean };
    };
    expect(envelope.error.retryable).toBe(false);
    expect(envelope.error.outcomeUncertain).not.toBe(true);
  } finally {
    await m.close();
  }
});

for (const operation of ['bulk', 'webhook', 'worker'] as const) {
  test(`malformed ${operation} replies after a real write require reconciliation`, async () => {
    const m = await startMcp({ mode: 'tcp' });
    try {
      let name: string;
      let args: Record<string, unknown>;
      if (operation === 'bulk') {
        const original = m.backend.addJobsBulk.bind(m.backend);
        m.backend.addJobsBulk = async (...values) => {
          await original(...values);
          throw new Error('Invalid PUSHB response from broker: missing job ids');
        };
        name = 'bunqueue_add_jobs_bulk';
        args = { queue: 'uncertain-bulk', jobs: [{ name: 'task', data: {} }] };
      } else if (operation === 'webhook') {
        const original = m.backend.addWebhook.bind(m.backend);
        m.backend.addWebhook = async (...values) => {
          await original(...values);
          throw new Error('Invalid AddWebhook response from broker: missing webhookId');
        };
        name = 'bunqueue_add_webhook';
        args = { url: 'https://example.com/unused', events: ['job.completed'] };
      } else {
        const original = m.backend.registerWorker.bind(m.backend);
        m.backend.registerWorker = async (...values) => {
          await original(...values);
          throw new Error('Invalid RegisterWorker response from broker: missing workerId');
        };
        name = 'bunqueue_register_worker';
        args = { name: 'uncertain-worker', queues: ['uncertain-worker'] };
      }
      const result = await m.client.callTool({ name, arguments: args });
      if (operation === 'bulk')
        expect((await m.backend.getJobCounts('uncertain-bulk')).waiting).toBe(1);
      else if (operation === 'webhook') expect(await m.backend.listWebhooks()).toHaveLength(1);
      else expect(await m.backend.listWorkers()).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        outcome: 'error',
        error: { retryable: false, outcomeUncertain: true },
        suggestedAction: expect.stringContaining('reconcile'),
      });
      expect((result.structuredContent as { error: { code: string } }).error.code).not.toBe(
        'invalid_input'
      );
    } finally {
      await m.close();
    }
  });
}

for (const mode of ['embedded', 'tcp'] as const) {
  test(`registered heartbeat, lock and handler tools advertise boolean results (${mode})`, async () => {
    const m = await startMcp({ mode });
    try {
      const { tools } = await m.client.listTools();
      const calls = [
        { name: 'bunqueue_worker_heartbeat', args: { workerId: 'missing-worker' } },
        { name: 'bunqueue_job_heartbeat', args: { jobId: 'missing-job' } },
        {
          name: 'bunqueue_extend_lock',
          args: { jobId: 'missing-job', token: 'missing-token', duration: 1000 },
        },
        { name: 'bunqueue_unregister_handler', args: { queue: 'missing-handler' } },
      ];
      for (const call of calls) {
        const tool = tools.find((candidate) => candidate.name === call.name);
        expect(tool).toBeDefined();
        const schema = tool?.outputSchema as {
          properties: { data: { anyOf: Array<{ properties?: { success?: { type?: string } } }> } };
        };
        expect(schema.properties.data.anyOf[0].properties?.success?.type).toBe('boolean');
        const result = await m.client.callTool({ name: call.name, arguments: call.args });
        expect(result.structuredContent).toMatchObject({
          outcome: 'not_applied',
          data: { success: false },
        });
      }
    } finally {
      await m.close();
    }
  });
}

test('dynamic argument rejection and unknown targets carry definite non-execution', async () => {
  const m = await startMcp({ env: { BUNQUEUE_MCP_TOOLSETS: 'dynamic,jobs' } });
  try {
    for (const args of [
      { name: 'bunqueue_add_job', arguments: { queue: 'dispatch-invalid' } },
      { name: 'bunqueue_missing_tool', arguments: {} },
    ]) {
      const result = await m.client.callTool({ name: 'bunqueue_call_tool', arguments: args });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        outcome: 'error',
        error: { retryable: false, outcomeUncertain: false },
      });
    }
    expect((await m.backend.getJobCounts('dispatch-invalid')).waiting).toBe(0);
  } finally {
    await m.close();
  }
});
