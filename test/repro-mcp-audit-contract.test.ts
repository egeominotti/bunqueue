import { expect, test } from 'bun:test';
import { startMcp } from './mcp-harness';

for (const mode of ['embedded', 'tcp'] as const) {
  test(`${mode}: an empty retry ID must not rerun completed jobs after refusal`, async () => {
    const mcp = await startMcp({
      mode,
      env: { BUNQUEUE_MCP_CONFIRM: 'destructive' },
      elicit: () => ({ action: 'decline' }),
    });
    try {
      const queue = 'audit-confirmation-regression';
      for (let i = 0; i < 2; i++) {
        const { jobId } = await mcp.backend.addJob(queue, 'effect', { i });
        await mcp.backend.pullJob(queue);
        await mcp.backend.ackJob(jobId, { applied: true });
      }
      const refused = await mcp.call('bunqueue_retry_completed', { queue });
      expect(refused.isError).toBe(true);
      expect((await mcp.backend.getJobCounts(queue)).completed).toBe(2);
      for (const jobId of ['', '   ']) {
        const invalid = await mcp.call('bunqueue_retry_completed', { queue, jobId });
        expect(invalid.isError).toBe(true);
        expect(await mcp.backend.getJobCounts(queue)).toMatchObject({ completed: 2, waiting: 0 });
      }
    } finally {
      await mcp.close();
    }
  });

  for (const operation of ['ack', 'fail', 'ackBatch'] as const) {
    test(`${mode}: ${operation} must not claim an expired execution completed`, async () => {
      const mcp = await startMcp({ mode });
      try {
        const queue = `audit-retired-${operation}`;
        await mcp.call('bunqueue_add_job', {
          queue,
          name: 'expires',
          data: {},
          attempts: 1,
          timeout: 20,
        });
        const pulled = await mcp.call('bunqueue_pull_job', {
          queue,
          owner: 'audit-worker',
          lockTtl: 30_000,
        });
        const lease = pulled.json.job as { id: string; token: string };
        const deadline = Date.now() + 5000;
        while ((await mcp.backend.getJobState(lease.id)) !== 'failed') {
          if (Date.now() >= deadline) throw new Error('Fixture did not reach failed state');
          await Bun.sleep(10);
        }
        const call =
          operation === 'ack'
            ? { name: 'bunqueue_ack_job', arguments: { jobId: lease.id, token: lease.token } }
            : operation === 'fail'
              ? { name: 'bunqueue_fail_job', arguments: { jobId: lease.id, token: lease.token } }
              : {
                  name: 'bunqueue_ack_job_batch',
                  arguments: { jobIds: [lease.id], tokens: [lease.token] },
                };
        const result = await mcp.client.callTool(call);
        expect(await mcp.backend.getJobCounts(queue)).toMatchObject({ completed: 0, failed: 1 });
        expect(result.structuredContent).toMatchObject({
          outcome: 'not_applied',
          data:
            operation === 'ackBatch'
              ? { success: false, count: 0, ignoredIds: [lease.id], ignoredIndices: [0] }
              : { success: false, jobId: lease.id, reason: 'already-finalized' },
        });
      } finally {
        await mcp.close();
      }
    });
  }

  test(`${mode}: a valid __proto__ queue must remain in per-queue monitoring`, async () => {
    const mcp = await startMcp({ mode });
    try {
      const added = await mcp.call('bunqueue_add_job', {
        queue: '__proto__',
        name: 'visible',
        data: {},
      });
      expect(added.isError).toBe(false);
      expect((await mcp.backend.getJobCounts('__proto__')).waiting).toBe(1);
      const stats = await mcp.call('bunqueue_get_per_queue_stats');
      expect(Object.keys(stats.json)).toContain('__proto__');
      expect(Object.hasOwn(stats.json, '__proto__')).toBe(true);
      expect(stats.json.__proto__).toMatchObject({ waiting: 1 });
    } finally {
      await mcp.close();
    }
  });

  test(`${mode}: a mixed ACK batch counts applied positions and identifies ignored positions`, async () => {
    const mcp = await startMcp({ mode });
    try {
      const queue = 'audit-mixed-batch';
      const { jobId: retired } = await mcp.backend.addJob(
        queue,
        'expires',
        {},
        {
          attempts: 1,
          timeout: 20,
        }
      );
      const lease = await mcp.backend.pullJob(queue, 0, { owner: 'audit-worker', lockTtl: 30_000 });
      if (!lease?.token) throw new Error('Fixture did not receive a locked execution');
      const deadline = Date.now() + 5000;
      while ((await mcp.backend.getJobState(retired)) !== 'failed') {
        if (Date.now() >= deadline) throw new Error('Fixture did not reach failed state');
        await Bun.sleep(10);
      }
      const { jobId: active } = await mcp.backend.addJob(queue, 'active', {});
      await mcp.backend.pullJob(queue);
      const result = await mcp.client.callTool({
        name: 'bunqueue_ack_job_batch',
        arguments: { jobIds: [retired, active, retired], tokens: [lease.token, '', lease.token] },
      });
      expect(result.structuredContent).toMatchObject({
        outcome: 'not_applied',
        data: { success: false, count: 1, ignoredIds: [retired, retired], ignoredIndices: [0, 2] },
      });
      expect(await mcp.backend.getJobCounts(queue)).toMatchObject({
        active: 0,
        completed: 1,
        failed: 1,
      });
      expect(await mcp.backend.getJobState(active)).toBe('completed');
    } finally {
      await mcp.close();
    }
  });

  test(`${mode}: successful consumption keeps its legacy payloads and undefined adapter results`, async () => {
    const mcp = await startMcp({ mode });
    try {
      const queue = 'audit-consumption-controls';
      const addActive = async () => {
        const { jobId } = await mcp.backend.addJob(queue, 'effect', {});
        await mcp.backend.pullJob(queue);
        return jobId;
      };
      for (const operation of ['ack', 'fail', 'ackBatch'] as const) {
        const jobId = await addActive();
        const result = await mcp.client.callTool({
          name:
            operation === 'ack'
              ? 'bunqueue_ack_job'
              : operation === 'fail'
                ? 'bunqueue_fail_job'
                : 'bunqueue_ack_job_batch',
          arguments:
            operation === 'ackBatch' ? { jobIds: [jobId] } : { jobId, unrecoverable: true },
        });
        expect(result.structuredContent).toEqual({
          outcome: 'success',
          data: operation === 'ackBatch' ? { success: true, count: 1 } : { success: true, jobId },
        });
        expect(await mcp.backend.getJobState(jobId)).toBe(
          operation === 'fail' ? 'failed' : 'completed'
        );
      }
      expect(await mcp.backend.ackJob(await addActive())).toBeUndefined();
      expect(await mcp.backend.ackJobBatch([await addActive()])).toBeUndefined();
      expect(
        await mcp.backend.failJob(await addActive(), 'control', { unrecoverable: true })
      ).toBeUndefined();
    } finally {
      await mcp.close();
    }
  });

  test(`${mode}: retrying one completed job bypasses bulk confirmation without broadening its target`, async () => {
    const mcp = await startMcp({ mode, env: { BUNQUEUE_MCP_CONFIRM: 'destructive' } });
    try {
      const queue = 'audit-single-retry';
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const { jobId } = await mcp.backend.addJob(queue, 'effect', {});
        ids.push(jobId);
        await mcp.backend.pullJob(queue);
        await mcp.backend.ackJob(jobId);
      }
      expect(
        (await mcp.call('bunqueue_retry_completed', { queue, jobId: ids[0] })).json.retried
      ).toBe(1);
      expect(await mcp.backend.getJobCounts(queue)).toMatchObject({ completed: 1, waiting: 1 });
    } finally {
      await mcp.close();
    }
  });

  test(`${mode}: an empty DLQ retry target cannot silently retry the whole DLQ`, async () => {
    const mcp = await startMcp({ mode });
    try {
      const queue = 'audit-dlq-retry-target';
      const { jobId } = await mcp.backend.addJob(queue, 'effect', {});
      await mcp.backend.pullJob(queue);
      await mcp.backend.failJob(jobId, 'fixture', { unrecoverable: true });
      for (const invalid of ['', '   ']) {
        expect((await mcp.call('bunqueue_retry_dlq', { queue, jobId: invalid })).isError).toBe(
          true
        );
        expect(await mcp.backend.getJobCounts(queue)).toMatchObject({ failed: 1, waiting: 0 });
      }
    } finally {
      await mcp.close();
    }
  });

  test(`${mode}: dynamic retry dispatch rejects blank IDs after a declined bulk confirmation`, async () => {
    const mcp = await startMcp({
      mode,
      env: { BUNQUEUE_MCP_CONFIRM: 'destructive', BUNQUEUE_MCP_TOOLSETS: 'dynamic,dlq' },
      elicit: () => ({ action: 'decline' }),
    });
    try {
      const queue = 'audit-dynamic-retry';
      const { jobId } = await mcp.backend.addJob(queue, 'effect', {});
      await mcp.backend.pullJob(queue);
      await mcp.backend.ackJob(jobId);
      const invoke = (args: Record<string, unknown>) =>
        mcp.client.callTool({
          name: 'bunqueue_call_tool',
          arguments: { name: 'bunqueue_retry_completed', arguments: { queue, ...args } },
        });
      expect((await invoke({})).isError).toBe(true);
      for (const invalid of ['', '   ']) {
        const result = await invoke({ jobId: invalid });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          outcome: 'error',
          error: { code: 'invalid_input', outcomeUncertain: false },
        });
        expect(await mcp.backend.getJobCounts(queue)).toMatchObject({ completed: 1, waiting: 0 });
      }
    } finally {
      await mcp.close();
    }
  });
}
