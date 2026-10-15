#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { WorkflowStore } from '../../src/client/workflow/store';
import { TOOLSET_IDS } from '../../src/mcp/toolPolicy';
import { openTaskHarness } from './task-harness';
import type { EvalMode } from './task-types';

function size(value: unknown) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  return { bytes, approxTokens: Math.ceil(bytes / 4) };
}

function describe(tools: Tool[]) {
  return { toolCount: tools.length, ...size({ tools }) };
}

async function list(env: Record<string, string>, mode: EvalMode = 'embedded') {
  const harness = await openTaskHarness(mode, env);
  try {
    return await harness.listTools();
  } finally {
    await harness.close();
  }
}

export async function measureCatalog() {
  const primary = describe(await list({}));
  const agentInitial = describe(await list({ BUNQUEUE_MCP_PROFILE: 'agent' }));
  const dynamic: Array<{
    toolset: string;
    toolCount: number;
    bytes: number;
    approxTokens: number;
    disclosureBytes: number;
    disclosureApproxTokens: number;
    completeSchemas: boolean;
  }> = [];
  for (const toolset of TOOLSET_IDS.filter((id) => id !== 'workflows')) {
    const harness = await openTaskHarness('embedded', { BUNQUEUE_MCP_PROFILE: 'agent' });
    try {
      const reply = await harness.call('bunqueue_enable_toolsets', { toolsets: [toolset] });
      if (reply.outcome !== 'success') throw new Error(`Disclosure failed for ${toolset}`);
      const tools = reply.data.tools as Tool[];
      const bytes = harness.calls[0].responseBytes;
      dynamic.push({
        toolset,
        ...describe(await harness.listTools()),
        disclosureBytes: bytes,
        disclosureApproxTokens: Math.ceil(bytes / 4),
        completeSchemas:
          tools.length > 0 &&
          tools.every((tool) => Boolean(tool.inputSchema && tool.outputSchema && tool.annotations)),
      });
    } finally {
      await harness.close();
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'bunqueue-catalog-workflow-'));
  const path = join(dir, 'workflow.db');
  const store = new WorkflowStore(path);
  store.close();
  const optionalWorkflows = [];
  try {
    for (const mode of ['embedded', 'tcp'] as const) {
      const tools = await list({ BUNQUEUE_MCP_WORKFLOW_DB: path }, mode);
      const optional = tools.filter((tool) => tool.name.includes('workflow'));
      const harness = await openTaskHarness(mode, {
        BUNQUEUE_MCP_PROFILE: 'agent',
        BUNQUEUE_MCP_WORKFLOW_DB: path,
      });
      try {
        const reply = await harness.call('bunqueue_enable_toolsets', { toolsets: ['workflows'] });
        if (reply.outcome !== 'success') throw new Error('Workflow disclosure failed');
        optionalWorkflows.push({
          mode,
          ...describe(optional),
          totalTools: tools.length,
          disclosureBytes: harness.calls[0].responseBytes,
        });
      } finally {
        await harness.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    measuredAt: new Date().toISOString(),
    serialization:
      'UTF-8 bytes of compact JSON tools/list result or complete tools/call disclosure result; includes annotations and input/output schemas',
    tokenApproximation: 'ceil(UTF-8 bytes / 4); not a model tokenizer',
    primary,
    agentInitial,
    dynamic,
    optionalWorkflows,
    decisionDiscovery:
      'bunqueue_find_tools adds one descriptor only when an optional decision model is configured; no provider was configured or called',
  };
}

if (import.meta.main) console.log(JSON.stringify(await measureCatalog(), null, 2));
