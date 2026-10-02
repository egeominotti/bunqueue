/**
 * Builds one fully registered bunqueue McpServer: the 75 tools (plus the optional
 * workflow tools) with their opt-in features (see toolSetup.ts), the resources and
 * the prompts. stdio uses a single server; the HTTP transport calls this once per
 * session, every server sharing the same backend and HTTP handler registry.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from '../shared/version';
import type { McpBackend } from './adapter';
import type { HttpHandlerRegistry } from './httpHandler';
import { registerPrompts } from './prompts';
import { registerResources } from './resources';
import { setupTools, type ToolSetupOptions } from './toolSetup';

export function createMcpServer(
  backend: McpBackend,
  handlerRegistry: HttpHandlerRegistry,
  options: ToolSetupOptions = {}
): McpServer {
  const server = new McpServer({
    name: 'bunqueue-mcp',
    version: VERSION,
  });

  // Register all tools (75, plus 3 optional workflow tools) and the opt-in features
  // (see toolSetup.ts); throws on invalid opt-in settings
  setupTools(server, backend, handlerRegistry, options);

  // Register resources and prompts (3)
  registerResources(server, backend);
  registerPrompts(server, backend);
  return server;
}
