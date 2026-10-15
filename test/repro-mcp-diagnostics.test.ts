import { describe, expect, test } from 'bun:test';
import { startMcp, type McpMode } from './mcp-harness';

for (const mode of ['embedded', 'tcp'] satisfies McpMode[]) {
  describe(`MCP diagnostic facts (${mode})`, () => {
    for (const paused of [false, true]) {
      test(`debug prompt counts a ${paused ? 'paused' : 'prioritized'} job`, async () => {
        const mcp = await startMcp({ mode, diagnosticPrompts: true });
        try {
          const queue = `diagnostic-${mode}-${paused}-${crypto.randomUUID()}`;
          await mcp.call('bunqueue_add_job', { queue, name: 'task', data: {}, priority: 7 });
          if (paused) await mcp.call('bunqueue_pause_queue', { queue });
          const counts = await mcp.call('bunqueue_get_job_counts', { queue });
          expect(counts.json[paused ? 'paused' : 'prioritized']).toBe(1);
          const prompt = await mcp.client.getPrompt({
            name: 'bunqueue_debug_queue',
            arguments: { queue },
          });
          const text = prompt.messages
            .map((m) => (m.content.type === 'text' ? m.content.text : ''))
            .join('\n');
          expect(text).toContain('Total jobs: 1');
        } finally {
          await mcp.close();
        }
      });
    }

    test('incident prompt includes observed rate-limit facts', async () => {
      const mcp = await startMcp({ mode, diagnosticPrompts: true });
      try {
        const queue = `diagnostic-limit-${crypto.randomUUID()}`;
        await mcp.call('bunqueue_set_rate_limit', { queue, limit: 1, duration: 60000 });
        await mcp.call('bunqueue_add_job', { queue, name: 'first', data: {} });
        await mcp.call('bunqueue_add_job', { queue, name: 'second', data: {} });
        const pulled = await mcp.call('bunqueue_pull_job', { queue });
        const job = pulled.json.job as { id: string };
        await mcp.call('bunqueue_ack_job', { jobId: job.id });
        const limits = await mcp.call('bunqueue_get_queue_limits', { queue });
        expect(limits.json.rateLimited).toBe(true);
        const prompt = await mcp.client.getPrompt({
          name: 'bunqueue_incident_response',
          arguments: { queue },
        });
        const text = prompt.messages
          .map((m) => (m.content.type === 'text' ? m.content.text : ''))
          .join('\n');
        expect(text).toContain('"rateLimited": true');
      } finally {
        await mcp.close();
      }
    });
  });
}
