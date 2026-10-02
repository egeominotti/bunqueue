/**
 * MCP tool policy invariants and the default (no opt-in) contract:
 * every tool is classified, toolsets partition the 75 tools, and without opt-in
 * env vars the tool list carries no annotations and no confirmation parameters.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { shutdownManager } from '../src/client/manager';
import { EmbeddedBackend } from '../src/mcp/adapter';
import { confirmModeFromEnv, decisionThresholdFromEnv } from '../src/mcp/confirmGuard';
import { decisionConfigFromEnv } from '../src/mcp/decisionModel';
import { HttpHandlerRegistry } from '../src/mcp/httpHandler';
import { TOOL_POLICIES, TOOLSET_IDS, annotationsFor } from '../src/mcp/toolPolicy';
import { setupTools } from '../src/mcp/toolSetup';
import { assertPolicyCoverage, toolsetModeFromEnv } from '../src/mcp/toolsets';
import { startMcp } from './mcp-harness';

const GUARDED = [
  'bunqueue_cancel_job',
  'bunqueue_clean_queue',
  'bunqueue_clear_job_logs',
  'bunqueue_delete_cron',
  'bunqueue_drain_queue',
  'bunqueue_obliterate_queue',
  'bunqueue_purge_dlq',
  'bunqueue_remove_webhook',
  'bunqueue_retry_completed',
  'bunqueue_signal_workflow',
];

/** Policies of tools registered without any opt-in setting. */
const alwaysOn = () =>
  Object.entries(TOOL_POLICIES)
    .filter(([, p]) => !p.optional)
    .map(([name]) => name);

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

describe('MCP tool policy', () => {
  test('every registered tool has exactly one policy and vice versa', () => {
    shutdownManager();
    const backend = new EmbeddedBackend();
    const handlers = new HttpHandlerRegistry();
    const tools = setupTools(new McpServer({ name: 't', version: '0' }), backend, handlers, {
      env: {},
    });
    try {
      expect(tools.size).toBe(75);
      expect(() => assertPolicyCoverage(tools)).not.toThrow();
      expect(alwaysOn().sort()).toEqual([...tools.keys()].sort());
    } finally {
      handlers.shutdown();
      backend.shutdown();
      shutdownManager();
    }
  });

  test('toolsets partition all 75 tools with no empty toolset', () => {
    const sizes = TOOLSET_IDS.map(
      (id) => Object.values(TOOL_POLICIES).filter((p) => p.toolset === id).length
    );
    expect(sizes.every((n) => n > 0)).toBe(true);
    expect(alwaysOn()).toHaveLength(75);
  });

  test('only irreversible or bulk re-execution tools are guarded', () => {
    const guarded = Object.entries(TOOL_POLICIES)
      .filter(([, p]) => p.confirm)
      .map(([name]) => name)
      .sort();
    expect(guarded).toEqual(GUARDED);
    for (const name of GUARDED) {
      const p = TOOL_POLICIES[name];
      expect(p.readOnly).toBe(false);
    }
  });

  test('annotations never mark a read-only tool destructive', () => {
    for (const policy of Object.values(TOOL_POLICIES)) {
      const a = annotationsFor(policy);
      if (a.readOnlyHint) expect(a.destructiveHint).toBe(false);
    }
    expect(annotationsFor(TOOL_POLICIES.bunqueue_obliterate_queue).destructiveHint).toBe(true);
    expect(annotationsFor(TOOL_POLICIES.bunqueue_get_stats).readOnlyHint).toBe(true);
  });
});

describe('MCP default contract (no opt-in)', () => {
  test('lists the 75 tools without annotations or confirmation parameters', async () => {
    const mcp = await startMcp();
    close = mcp.close;
    const { tools } = await mcp.client.listTools();
    expect(tools).toHaveLength(75);
    for (const tool of tools) {
      expect(tool.annotations).toBeUndefined();
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect('confirm' in props).toBe(false);
      expect('userRequest' in props).toBe(false);
    }
  });

  test('destructive tools run immediately, as before', async () => {
    const mcp = await startMcp();
    close = mcp.close;
    await mcp.call('bunqueue_add_job', { queue: 'plain', name: 'a', data: {} });
    const result = await mcp.call('bunqueue_obliterate_queue', { queue: 'plain' });
    expect(result.isError).toBe(false);
    expect((await mcp.backend.getJobCounts('plain')).waiting).toBe(0);
  });
});

describe('MCP opt-in configuration parsing', () => {
  test('toolsets', () => {
    expect(toolsetModeFromEnv({})).toEqual({ kind: 'all' });
    expect(toolsetModeFromEnv({ BUNQUEUE_MCP_TOOLSETS: 'ALL' })).toEqual({ kind: 'all' });
    expect(toolsetModeFromEnv({ BUNQUEUE_MCP_TOOLSETS: 'dlq, queues,dlq' })).toEqual({
      kind: 'static',
      toolsets: ['dlq', 'queues'],
    });
    expect(toolsetModeFromEnv({ BUNQUEUE_MCP_TOOLSETS: 'dynamic,monitoring' })).toEqual({
      kind: 'dynamic',
      preload: ['monitoring'],
    });
    expect(() => toolsetModeFromEnv({ BUNQUEUE_MCP_TOOLSETS: 'queue' })).toThrow(/Unknown/);
    expect(() => toolsetModeFromEnv({ BUNQUEUE_MCP_TOOLSETS: ',' })).toThrow(/no toolset/);
  });

  test('confirmation and threshold', () => {
    expect(confirmModeFromEnv({})).toBe(false);
    expect(confirmModeFromEnv({ BUNQUEUE_MCP_CONFIRM: 'off' })).toBe(false);
    expect(confirmModeFromEnv({ BUNQUEUE_MCP_CONFIRM: 'Destructive' })).toBe(true);
    expect(() => confirmModeFromEnv({ BUNQUEUE_MCP_CONFIRM: 'yes' })).toThrow();
    expect(decisionThresholdFromEnv({})).toBe(0.8);
    expect(() => decisionThresholdFromEnv({ BUNQUEUE_MCP_DECISION_THRESHOLD: '0' })).toThrow();
    expect(() => decisionThresholdFromEnv({ BUNQUEUE_MCP_DECISION_THRESHOLD: 'x' })).toThrow();
  });

  test('decision providers', () => {
    expect(decisionConfigFromEnv({})).toBeNull();
    expect(
      decisionConfigFromEnv({
        BUNQUEUE_MCP_DECISION_PROVIDER: 'typesafe',
        BUNQUEUE_MCP_DECISION_API_KEY: 'k',
      })
    ).toMatchObject({ model: 'jev-latest', url: 'https://api.typesafe.ai/v1/systemone' });
    expect(
      decisionConfigFromEnv({
        BUNQUEUE_MCP_DECISION_PROVIDER: 'cloudflare',
        BUNQUEUE_MCP_DECISION_API_KEY: 'k',
        BUNQUEUE_MCP_DECISION_ACCOUNT_ID: 'acc',
        BUNQUEUE_MCP_DECISION_MODEL: 'clef',
      })?.url
    ).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef');
    expect(
      decisionConfigFromEnv({
        BUNQUEUE_MCP_DECISION_PROVIDER: 'systemone',
        BUNQUEUE_MCP_DECISION_URL: 'http://127.0.0.1:8000/v1/systemone',
        BUNQUEUE_MCP_DECISION_MODEL: 'kev-9b',
      })
    ).toMatchObject({ model: 'kev-9b', apiKey: undefined });
    expect(() => decisionConfigFromEnv({ BUNQUEUE_MCP_DECISION_PROVIDER: 'openai' })).toThrow();
    expect(() => decisionConfigFromEnv({ BUNQUEUE_MCP_DECISION_PROVIDER: 'typesafe' })).toThrow(
      /API_KEY/
    );
    expect(() =>
      decisionConfigFromEnv({
        BUNQUEUE_MCP_DECISION_PROVIDER: 'cloudflare',
        BUNQUEUE_MCP_DECISION_API_KEY: 'k',
      })
    ).toThrow(/ACCOUNT_ID/);
    expect(() => decisionConfigFromEnv({ BUNQUEUE_MCP_DECISION_PROVIDER: 'systemone' })).toThrow(
      /MODEL/
    );
    expect(() =>
      decisionConfigFromEnv({
        BUNQUEUE_MCP_DECISION_PROVIDER: 'systemone',
        BUNQUEUE_MCP_DECISION_MODEL: 'laya',
      })
    ).toThrow(/URL/);
  });
});
