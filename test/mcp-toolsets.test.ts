/**
 * BUNQUEUE_MCP_TOOLSETS: static subsets, dynamic loading with tools/list_changed,
 * the bunqueue_call_tool fallback, and decision-model routing via bunqueue_find_tools.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { DecisionModel } from '../src/mcp/decisionModel';
import { TOOLSET_IDS, TOOL_POLICIES } from '../src/mcp/toolPolicy';
import { fakeDecisionServer, startMcp } from './mcp-harness';

const toolsIn = (...sets: string[]) =>
  Object.entries(TOOL_POLICIES)
    .filter(([, p]) => sets.includes(p.toolset))
    .map(([name]) => name)
    .sort();

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function mcp(options: Parameters<typeof startMcp>[0]) {
  const m = await startMcp(options);
  cleanups.push(m.close);
  return m;
}

describe('static toolsets', () => {
  test('lists exactly the selected toolsets', async () => {
    const m = await mcp({ env: { BUNQUEUE_MCP_TOOLSETS: 'queues,dlq' } });
    expect(await m.toolNames()).toEqual(toolsIn('queues', 'dlq'));
  });

  test('tools outside the selection cannot be called', async () => {
    const m = await mcp({ env: { BUNQUEUE_MCP_TOOLSETS: 'monitoring' } });
    const result = await m.call('bunqueue_add_job', { queue: 'q', name: 'n', data: {} });
    expect(result.isError).toBe(true);
    expect((await m.backend.getJobCounts('q')).waiting).toBe(0);
  });
});

describe('dynamic toolsets', () => {
  test('starts from the catalog only and loads toolsets on demand', async () => {
    const m = await mcp({ env: { BUNQUEUE_MCP_TOOLSETS: 'dynamic' } });
    expect(await m.toolNames()).toEqual(['bunqueue_call_tool', 'bunqueue_enable_toolsets']);
    const catalog = (await m.client.listTools()).tools.find(
      (t) => t.name === 'bunqueue_enable_toolsets'
    );
    // The opt-in workflows toolset is listed only when BUNQUEUE_MCP_WORKFLOW_DB is set.
    for (const id of TOOLSET_IDS.filter((t) => t !== 'workflows')) {
      expect(catalog?.description).toContain(`- ${id}:`);
    }

    const loaded = await m.call('bunqueue_enable_toolsets', { toolsets: ['dlq'] });
    expect(loaded.isError).toBe(false);
    const listed = (
      loaded.json.tools as Array<{ name: string; inputSchema: { properties?: object } }>
    ).map((t) => t.name);
    expect(listed.sort()).toEqual(toolsIn('dlq'));
    expect(
      (loaded.json.tools as Array<{ inputSchema: { properties?: object } }>)[0].inputSchema
        .properties
    ).toBeDefined();
    await Bun.sleep(20);
    expect(m.listChanged()).toBeGreaterThan(0);
    expect(await m.toolNames()).toEqual(
      ['bunqueue_call_tool', 'bunqueue_enable_toolsets', ...toolsIn('dlq')].sort()
    );
  });

  test('preloads toolsets named next to dynamic', async () => {
    const m = await mcp({ env: { BUNQUEUE_MCP_TOOLSETS: 'dynamic,monitoring' } });
    expect(await m.toolNames()).toEqual(
      ['bunqueue_call_tool', 'bunqueue_enable_toolsets', ...toolsIn('monitoring')].sort()
    );
  });

  test('rejects unknown toolset names in enable_toolsets', async () => {
    const m = await mcp({ env: { BUNQUEUE_MCP_TOOLSETS: 'dynamic' } });
    const result = await m.call('bunqueue_enable_toolsets', { toolsets: ['everything'] });
    expect(result.isError).toBe(true);
  });

  test('call_tool runs loaded tools on the real backend and validates arguments', async () => {
    const m = await mcp({ env: { BUNQUEUE_MCP_TOOLSETS: 'dynamic' } });
    const notLoaded = await m.call('bunqueue_call_tool', {
      name: 'bunqueue_add_job',
      arguments: {},
    });
    expect(notLoaded.isError).toBe(true);
    expect(String(notLoaded.json.error)).toContain('["jobs"]');

    await m.call('bunqueue_enable_toolsets', { toolsets: ['jobs'] });
    const invalid = await m.call('bunqueue_call_tool', {
      name: 'bunqueue_add_job',
      arguments: { queue: 'q' },
    });
    expect(invalid.isError).toBe(true);
    expect(String(invalid.json.error)).toContain('Invalid arguments');

    const added = await m.call('bunqueue_call_tool', {
      name: 'bunqueue_add_job',
      arguments: { queue: 'calls', name: 'welcome', data: { to: 'ada@example.com' } },
    });
    expect(added.isError).toBe(false);
    const jobId = String(added.json.jobId);
    const fetched = await m.call('bunqueue_call_tool', {
      name: 'bunqueue_get_job',
      arguments: { jobId },
    });
    expect(fetched.isError).toBe(false);
    expect(fetched.text).toContain('ada@example.com');

    const unknown = await m.call('bunqueue_call_tool', { name: 'bunqueue_nope' });
    expect(unknown.isError).toBe(true);
  });
});

describe('find_tools with a decision model', () => {
  test('is absent without a decision model', async () => {
    const m = await mcp({ env: { BUNQUEUE_MCP_TOOLSETS: 'dynamic' } });
    expect(await m.toolNames()).not.toContain('bunqueue_find_tools');
  });

  test('asks the model to choose a toolset and loads it', async () => {
    const fake = fakeDecisionServer(() => ({
      answers: {
        pick: {
          type: 'choice',
          choice: 'cron',
          probabilities: { cron: 0.97, queues: 0.03 },
          confidence: 0.96,
        },
      },
    }));
    cleanups.push(fake.stop);
    const decision = new DecisionModel({
      provider: 'systemone',
      model: 'clef-flash',
      url: fake.url,
      timeoutMs: 2000,
    });
    const m = await mcp({ env: { BUNQUEUE_MCP_TOOLSETS: 'dynamic' }, decision });

    const result = await m.call('bunqueue_find_tools', {
      request: 'schedule a report every Monday at 9',
    });
    expect(result.isError).toBe(false);
    expect(result.json.enabled).toEqual(['cron']);
    expect(await m.toolNames()).toEqual(expect.arrayContaining(toolsIn('cron')));

    const sent = fake.calls[0].body as {
      model: string;
      state: string;
      questions: { pick: { type: string; criteria: object } };
    };
    expect(sent.model).toBe('clef-flash');
    expect(sent.state).toBe('schedule a report every Monday at 9');
    expect(sent.questions.pick.type).toBe('choice');
    expect(Object.keys(sent.questions.pick.criteria).sort()).toEqual(
      TOOLSET_IDS.filter((t) => t !== 'workflows').sort()
    );
  });

  test('falls back to the catalog when the model fails', async () => {
    const fake = fakeDecisionServer(() => new Response('overloaded', { status: 529 }));
    cleanups.push(fake.stop);
    const decision = new DecisionModel({
      provider: 'systemone',
      model: 'laya',
      url: fake.url,
      timeoutMs: 2000,
    });
    const m = await mcp({ env: { BUNQUEUE_MCP_TOOLSETS: 'dynamic' }, decision });
    const result = await m.call('bunqueue_find_tools', { request: 'pause the emails queue' });
    expect(result.isError).toBe(true);
    expect(String(result.json.error)).toContain('bunqueue_enable_toolsets');
    expect(fake.calls).toHaveLength(2);
  });
});
