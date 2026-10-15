/** Read-only disclosure of effective MCP configuration; never returns secret settings. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EmbeddedBackend, type McpBackend } from './adapter';
import { TOOL_POLICIES, TOOLSET_IDS } from './toolPolicy';
import type { ToolSettings } from './toolSetup';

export function registerCapabilities(
  server: McpServer,
  backend: McpBackend,
  settings: ToolSettings
) {
  server.tool(
    'bunqueue_get_capabilities',
    'Inspect effective MCP mode, profile, discovery, confirmation and configured workflow capabilities without changing queue state.',
    {},
    () => {
      const toolsets = TOOLSET_IDS.filter((id) => id !== 'workflows' || settings.workflows);
      const data = {
        mode: backend instanceof EmbeddedBackend ? 'embedded' : 'tcp',
        profile: settings.profile,
        discovery: settings.toolsets.kind,
        confirmation: settings.confirm,
        toolsets,
        workflows: {
          configured: Boolean(settings.workflows),
          inspection: Boolean(settings.workflows),
          signal: Boolean(settings.workflows && !settings.workflows.signalUnavailable),
        },
        structuredResults: true,
        observation: true,
        toolCount:
          Object.values(TOOL_POLICIES).filter((policy) => !policy.optional).length +
          (settings.workflows ? (settings.workflows.signalUnavailable ? 2 : 3) : 0),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );
}
