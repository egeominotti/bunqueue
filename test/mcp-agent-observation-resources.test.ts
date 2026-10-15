import { expect, test } from 'bun:test';
import { startMcp } from './mcp-harness';

test('scoped resources expose bounded safe pages and reject invalid page arguments', async () => {
  const m = await startMcp({ inspectionResources: true });
  try {
    await m.backend.addJob('scoped', 'task', { secret: 'private-resource-data' });
    const templates = await m.client.listResourceTemplates();
    expect(templates.resourceTemplates.length).toBe(2);
    const page = await m.client.readResource({ uri: 'bunqueue://queue/scoped/jobs/all/0/1' });
    const text = (page.contents[0] as { text: string }).text;
    expect(JSON.parse(text)).toMatchObject({ count: 1, hasMore: false, projection: 'summary' });
    expect(text).not.toContain('private-resource-data');
    const invalid = await m.client.readResource({ uri: 'bunqueue://queue/scoped/jobs/all/0/101' });
    expect(JSON.parse((invalid.contents[0] as { text: string }).text).isError).toBe(true);
  } finally {
    await m.close();
  }
});

test('broad resources disclose omitted queue totals and bound giant worker strings', async () => {
  const m = await startMcp({ inspectionResources: true, diagnosticPrompts: true });
  try {
    for (let i = 0; i < 60; i++) await m.backend.addJob(`bounded-queue-${i}`, 'task', {});
    await m.backend.registerWorker('💡'.repeat(100000), ['bounded-queue-0']);
    for (let i = 0; i < 50; i++)
      await m.backend.registerWorker(
        '💡'.repeat(120),
        Array.from({ length: 10 }, (_, j) => `worker-queue-${j}-${'x'.repeat(100)}`)
      );
    const resource = await m.client.readResource({ uri: 'bunqueue://queues' });
    const text = (resource.contents[0] as { text: string }).text;
    expect(JSON.parse(text).at(-1)).toMatchObject({ truncated: true, total: 60, shown: 50 });
    const prompt = await m.client.getPrompt({ name: 'bunqueue_health_report' });
    const promptText = prompt.messages
      .map((m) => (m.content.type === 'text' ? m.content.text : ''))
      .join('\n');
    expect(Buffer.byteLength(promptText)).toBeLessThanOrEqual(65536);
    expect(promptText).toContain('truncated');
  } finally {
    await m.close();
  }
});

test('debug prompt includes dependency-waiting parents in total accounting', async () => {
  const m = await startMcp({ diagnosticPrompts: true });
  try {
    await m.backend.addFlow({
      name: 'parent',
      queueName: 'parent-queue',
      children: [{ name: 'child', queueName: 'child-queue', data: {} }],
    });
    expect((await m.backend.getJobCounts('parent-queue'))['waiting-children']).toBe(1);
    const prompt = await m.client.getPrompt({
      name: 'bunqueue_debug_queue',
      arguments: { queue: 'parent-queue' },
    });
    const text = prompt.messages
      .map((m) => (m.content.type === 'text' ? m.content.text : ''))
      .join('\n');
    expect(text).toContain('Total jobs: 1');
  } finally {
    await m.close();
  }
});
