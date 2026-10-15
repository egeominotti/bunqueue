import { describe, expect, test } from 'bun:test';
import { startMcp, type McpMode } from './mcp-harness';

for (const mode of ['embedded', 'tcp'] satisfies McpMode[]) {
  describe(`MCP inspection boundaries (${mode})`, () => {
    test('server-wide incident prompt discloses queues omitted by its row cap', async () => {
      const m = await startMcp({ mode, diagnosticPrompts: true });
      try {
        for (let i = 0; i < 60; i++) await m.backend.addJob(`incident-cap-${i}`, 'task', {});
        const prompt = await m.client.getPrompt({
          name: 'bunqueue_incident_response',
          arguments: {},
        });
        const text = prompt.messages
          .map((msg) => (msg.content.type === 'text' ? msg.content.text : ''))
          .join('\n');
        expect(text).toContain('of 60');
        expect(text).toContain('truncated');
      } finally {
        await m.close();
      }
    });

    if (mode === 'embedded')
      test('queue resource reports one accurate omission record when row and byte caps combine', async () => {
        const m = await startMcp({ mode, inspectionResources: true });
        try {
          for (let i = 0; i < 60; i++) {
            await m.backend.addJob(`${String.fromCharCode(1).repeat(250)}${i}`, 'task', {});
          }
          const resource = await m.client.readResource({ uri: 'bunqueue://queues' });
          const rows = JSON.parse((resource.contents[0] as { text: string }).text) as Array<
            Record<string, unknown>
          >;
          const markers = rows.filter((row) => row.truncated === true);
          expect(markers).toHaveLength(1);
          expect(markers[0]).toMatchObject({ total: 60, shown: rows.length - 1 });
          expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(65536);
        } finally {
          await m.close();
        }
      });

    test('scoped resources resolve the actual encoded queue name', async () => {
      const m = await startMcp({ mode, inspectionResources: true });
      try {
        const queue = mode === 'tcp' ? 'review:queue' : 'review queue/💡%';
        await m.backend.addJob(queue, 'task', {});
        const resource = await m.client.readResource({
          uri: `bunqueue://queue/${encodeURIComponent(queue)}`,
        });
        const value = JSON.parse((resource.contents[0] as { text: string }).text);
        expect(value.total).toBe(1);
        expect(value.queue).toBe(queue);
        const page = await m.client.readResource({
          uri: `bunqueue://queue/${encodeURIComponent(queue)}/jobs/all/0/1`,
        });
        const jobs = JSON.parse((page.contents[0] as { text: string }).text);
        expect(jobs.queue).toBe(queue);
        expect(jobs.count).toBe(1);
        expect((jobs.jobs as Array<{ id: string }>)[0].id).toBeString();
        const malformed = await m.client.readResource({ uri: 'bunqueue://queue/malformed%escape' });
        expect(JSON.parse((malformed.contents[0] as { text: string }).text).isError).toBe(true);
        const malformedPage = await m.client.readResource({
          uri: 'bunqueue://queue/malformed%escape/jobs/all/0/1',
        });
        expect(JSON.parse((malformedPage.contents[0] as { text: string }).text).isError).toBe(true);
      } finally {
        await m.close();
      }
    });

    if (mode === 'embedded')
      test('escaped identifiers produce an object page with explicit truncation', async () => {
        const m = await startMcp({ mode });
        try {
          const queue = String.fromCharCode(1).repeat(256);
          const added = await m.call('bunqueue_add_job', {
            queue,
            name: String.fromCharCode(2).repeat(256),
            jobId: String.fromCharCode(3).repeat(256),
            data: {},
          });
          expect(added.isError).toBe(false);
          const page = await m.call('bunqueue_list_jobs_page', { queue });
          expect(page.isError).toBe(false);
          expect(page.json.count).toBe(1);
          expect((page.json.jobs as unknown[])[0]).toBeObject();
          expect(page.json.truncated).toBe(true);
          expect((page.json.jobs as Array<{ id: string }>)[0].id).toBe(
            String.fromCharCode(3).repeat(256)
          );
        } finally {
          await m.close();
        }
      });

    if (mode === 'embedded')
      test('page budget includes escaped outer metadata without skipping jobs', async () => {
        const m = await startMcp({ mode });
        try {
          const queue = String.fromCharCode(1).repeat(1024);
          for (let i = 0; i < 100; i++) {
            await m.backend.addJob(queue, 'task', { value: String.fromCharCode(4).repeat(256) });
          }
          const page = await m.call('bunqueue_list_jobs_page', {
            queue,
            limit: 100,
            includeData: true,
          });
          expect(page.isError).toBe(false);
          expect(Buffer.byteLength(JSON.stringify(page.json))).toBeLessThanOrEqual(65536);
          expect(page.json.count).toBeGreaterThan(0);
          expect(page.json.hasMore).toBe(true);
          expect(page.json.nextOffset).toBe(page.json.count);
          expect(page.json.truncated).toBe(true);
        } finally {
          await m.close();
        }
      });
  });
}

test('bounded pages preserve a usable admitted custom job identifier', async () => {
  const m = await startMcp();
  try {
    const jobId = `custom-${'x'.repeat(300)}`;
    const added = await m.call('bunqueue_add_job', {
      queue: 'identity-page',
      name: 'task',
      jobId,
      data: {},
    });
    expect(added.isError).toBe(false);
    const page = await m.call('bunqueue_list_jobs_page', { queue: 'identity-page' });
    expect(page.isError).toBe(false);
    const id = (page.json.jobs as Array<{ id: string }>)[0].id;
    expect(id).toBe(jobId);
    expect((await m.call('bunqueue_get_job', { jobId: id })).isError).toBe(false);
  } finally {
    await m.close();
  }
});
