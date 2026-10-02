/**
 * Opt-in tool disclosure for the MCP server (BUNQUEUE_MCP_TOOLSETS).
 *
 * - unset / "all": every tool, exactly as before.
 * - "queues,dlq": only those toolsets are listed (works with every client).
 * - "dynamic[,toolset...]": the agent starts from a short toolset catalog and loads
 *   groups on demand with bunqueue_enable_toolsets (tools/list_changed). Clients
 *   that do not refresh their tool list call loaded tools through bunqueue_call_tool.
 *   With a decision model configured, bunqueue_find_tools picks the toolset for a
 *   plain-language request.
 */

import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  safeParseAsync,
  type AnyObjectSchema,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { DecisionModel } from './decisionModel';
import { TOOLSETS, TOOLSET_IDS, TOOL_POLICIES, type ToolsetId } from './toolPolicy';

export type ToolsetMode =
  | { kind: 'all' }
  | { kind: 'static'; toolsets: ToolsetId[] }
  | { kind: 'dynamic'; preload: ToolsetId[] };

export function toolsetModeFromEnv(env: NodeJS.ProcessEnv = process.env): ToolsetMode {
  const raw = env.BUNQUEUE_MCP_TOOLSETS?.trim().toLowerCase();
  if (!raw || raw === 'all') return { kind: 'all' };
  const parts = [
    ...new Set(
      raw
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    ),
  ];
  const dynamic = parts.includes('dynamic');
  const named = parts.filter((p) => p !== 'dynamic');
  const unknown = named.filter((p) => !(TOOLSET_IDS as string[]).includes(p));
  if (unknown.length) {
    throw new Error(
      `Unknown BUNQUEUE_MCP_TOOLSETS value(s): ${unknown.join(', ')}. Valid: all, dynamic, ${TOOLSET_IDS.join(', ')}`
    );
  }
  const toolsets = named as ToolsetId[];
  if (dynamic) return { kind: 'dynamic', preload: toolsets };
  if (!toolsets.length) throw new Error('BUNQUEUE_MCP_TOOLSETS lists no toolset');
  return { kind: 'static', toolsets };
}

/**
 * Throw when a registered tool has no policy, or a policy names a tool that no longer
 * exists. Policies marked `optional` belong to opt-in tools and may be absent.
 */
export function assertPolicyCoverage(tools: Map<string, RegisteredTool>): void {
  const missing = [...tools.keys()].filter((name) => !TOOL_POLICIES[name]);
  const stale = Object.entries(TOOL_POLICIES)
    .filter(([name, policy]) => !policy.optional && !tools.has(name))
    .map(([name]) => name);
  if (missing.length || stale.length) {
    throw new Error(
      `MCP tool policy is out of date (missing: ${missing.join(', ') || 'none'}; stale: ${stale.join(', ') || 'none'})`
    );
  }
}

/** The question bunqueue_find_tools asks the decision model (also used by scripts/mcp-eval). */
export const FIND_TOOLS_QUESTION =
  'Which group of job-queue tools contains the tool needed to fulfil this request?';

const catalog = (ids: ToolsetId[]) => ids.map((id) => `- ${id}: ${TOOLSETS[id]}`).join('\n');

function text(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError } : {}),
  };
}

function toolsOf(tools: Map<string, RegisteredTool>, toolset: ToolsetId) {
  return [...tools].filter(([name]) => TOOL_POLICIES[name]?.toolset === toolset);
}

/** Toolsets with at least one registered tool (opt-in toolsets can be empty). */
function availableToolsets(tools: Map<string, RegisteredTool>): ToolsetId[] {
  return TOOLSET_IDS.filter((id) => toolsOf(tools, id).length > 0);
}

function enable(tools: Map<string, RegisteredTool>, toolsets: ToolsetId[]) {
  const loaded: Array<{ name: string; description?: string; inputSchema: unknown }> = [];
  for (const toolset of toolsets) {
    for (const [name, tool] of toolsOf(tools, toolset)) {
      if (!tool.enabled) tool.enable();
      loaded.push({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema
          ? toJsonSchemaCompat(tool.inputSchema as AnyObjectSchema)
          : {},
      });
    }
  }
  return {
    enabled: toolsets,
    tools: loaded,
    note: 'These tools are now listed. If your client does not refresh its tool list, call them through bunqueue_call_tool.',
  };
}

export function applyToolsets(
  server: McpServer,
  tools: Map<string, RegisteredTool>,
  mode: ToolsetMode,
  decision: DecisionModel | null
): void {
  if (mode.kind === 'all') return;
  const selected = mode.kind === 'static' ? mode.toolsets : mode.preload;
  const available = availableToolsets(tools);
  const empty = selected.filter((id) => !available.includes(id));
  if (empty.length) {
    throw new Error(
      `BUNQUEUE_MCP_TOOLSETS selects toolsets with no tool in this configuration: ${empty.map((id) => `${id} (${TOOLSETS[id]})`).join('; ')}`
    );
  }
  const keep = new Set<ToolsetId>(selected);
  for (const [name, tool] of tools) {
    if (!keep.has(TOOL_POLICIES[name].toolset)) tool.disable();
  }
  if (mode.kind === 'static') return;

  server.tool(
    'bunqueue_enable_toolsets',
    `Load groups of bunqueue tools before using them. Pick every toolset the task needs, then call the listed tools.\nToolsets:\n${catalog(available)}`,
    {
      toolsets: z
        .array(z.enum(available as [ToolsetId, ...ToolsetId[]]))
        .min(1)
        .describe('Toolsets to load'),
    },
    { readOnlyHint: true, openWorldHint: false },
    async ({ toolsets }) => text(enable(tools, toolsets))
  );

  server.tool(
    'bunqueue_call_tool',
    'Call a loaded bunqueue tool by name, for clients that do not refresh their tool list after bunqueue_enable_toolsets.',
    {
      name: z.string().describe('Tool name, e.g. bunqueue_get_job_counts'),
      arguments: z.record(z.string(), z.unknown()).optional().describe('Tool arguments'),
    },
    async ({ name, arguments: args }, extra) => {
      const tool = tools.get(name);
      if (!tool) return text({ error: `Unknown tool ${name}` }, true);
      if (!tool.enabled) {
        const toolset = TOOL_POLICIES[name].toolset;
        return text(
          {
            error: `${name} is not loaded; call bunqueue_enable_toolsets with ["${toolset}"] first`,
          },
          true
        );
      }
      const parsed = tool.inputSchema
        ? await safeParseAsync(tool.inputSchema as AnyObjectSchema, args ?? {})
        : { success: true as const, data: args ?? {} };
      if (!parsed.success) {
        return text({ error: `Invalid arguments for ${name}`, issues: String(parsed.error) }, true);
      }
      const handler = tool.handler as unknown as (a: unknown, e: unknown) => Promise<unknown>;
      return (await handler(parsed.data, extra)) as ReturnType<typeof text>;
    }
  );

  if (!decision) return;
  server.tool(
    'bunqueue_find_tools',
    'Describe what you need in plain language; a decision model picks and loads the matching bunqueue toolset.',
    { request: z.string().min(1).describe('What you want to do, in plain language') },
    { readOnlyHint: true, openWorldHint: true },
    async ({ request }) => {
      try {
        const answer = await decision.choice(
          request,
          FIND_TOOLS_QUESTION,
          Object.fromEntries(available.map((id) => [id, TOOLSETS[id]]))
        );
        return text({
          ...enable(tools, [answer.choice as ToolsetId]),
          probabilities: answer.probabilities,
        });
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        return text(
          {
            error: `Decision model unavailable (${cause}); pick a toolset with bunqueue_enable_toolsets`,
          },
          true
        );
      }
    }
  );
}
