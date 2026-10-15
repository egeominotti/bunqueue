import { expect, test } from 'bun:test';
import type { TcpConnectionPool } from '../src/client/tcpPool';
import type { McpBackend } from '../src/mcp/adapter';
import { startMcp } from './mcp-harness';

const malformedSingles = [
  null,
  [],
  { applied: false, reason: 'unsupported' },
  { applied: false },
  { applied: true },
];
const malformedBatches = [
  null,
  [],
  { ignoredIds: ['other-job'] },
  { ignoredIndices: 'bad' },
  { ignoredIndices: [-1] },
  { ignoredIndices: [0.5] },
  { ignoredIndices: [1] },
  { ignoredIndices: [0, 0, 0] },
  { ignoredIndices: [0], ignoredIds: [] },
  { ignoredIndices: [0], ignoredIds: ['other-job'] },
];

for (const operation of ['ACK', 'FAIL', 'ACKB'] as const) {
  const payloads = operation === 'ACKB' ? malformedBatches : malformedSingles;
  for (const [index, payload] of payloads.entries()) {
    test(`TCP ${operation}: malformed outcome ${index} cannot claim an applied or ignored result`, async () => {
      const mcp = await startMcp({ mode: 'tcp' });
      try {
        const queue = `audit-invalid-${operation}-${index}`;
        const { jobId } = await mcp.backend.addJob(queue, 'effect', {});
        await mcp.backend.pullJob(queue);
        // Corrupt only the outcome after the real broker has applied the write.
        const pool = (mcp.backend as unknown as { pool: TcpConnectionPool }).pool;
        const send = pool.send.bind(pool);
        pool.send = async (command, options) => {
          const result = await send(command, options);
          return command.cmd === operation ? { ...result, data: payload } : result;
        };
        const result = await mcp.client.callTool({
          name:
            operation === 'ACKB'
              ? 'bunqueue_ack_job_batch'
              : operation === 'ACK'
                ? 'bunqueue_ack_job'
                : 'bunqueue_fail_job',
          arguments: operation === 'ACKB' ? { jobIds: [jobId] } : { jobId, unrecoverable: true },
        });
        expect(await mcp.backend.getJobState(jobId)).toBe(
          operation === 'FAIL' ? 'failed' : 'completed'
        );
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          outcome: 'error',
          error: { outcomeUncertain: true, retryable: false },
        });
      } finally {
        await mcp.close();
      }
    });
  }
}

test('legacy adapters with explicit Promise<void> consumption methods remain compatible', async () => {
  const mcp = await startMcp();
  try {
    const ack = mcp.backend.ackJob.bind(mcp.backend);
    const ackBatch = mcp.backend.ackJobBatch.bind(mcp.backend);
    const fail = mcp.backend.failJob.bind(mcp.backend);
    const legacy: Pick<McpBackend, 'ackJob' | 'ackJobBatch' | 'failJob'> = {
      async ackJob(id, result, token): Promise<void> {
        await ack(id, result, token);
      },
      async ackJobBatch(ids, tokens): Promise<void> {
        await ackBatch(ids, tokens);
      },
      async failJob(id, error, options): Promise<void> {
        await fail(id, error, options);
      },
    };
    Object.assign(mcp.backend, legacy);
    const queue = 'audit-legacy-adapter';
    for (const name of ['bunqueue_ack_job', 'bunqueue_ack_job_batch', 'bunqueue_fail_job']) {
      const { jobId } = await mcp.backend.addJob(queue, 'effect', {});
      await mcp.backend.pullJob(queue);
      const batch = name === 'bunqueue_ack_job_batch';
      const result = await mcp.client.callTool({
        name,
        arguments: batch ? { jobIds: [jobId] } : { jobId, unrecoverable: true },
      });
      expect(result.structuredContent).toEqual({
        outcome: 'success',
        data: batch ? { success: true, count: 1 } : { success: true, jobId },
      });
      expect(await mcp.backend.getJobState(jobId)).toBe(
        name === 'bunqueue_fail_job' ? 'failed' : 'completed'
      );
    }
  } finally {
    await mcp.close();
  }
});
