/**
 * bunqueue MCP Server — implementation.
 *
 * Loaded lazily by ./index.ts (the `bunqueue-mcp` bin) via dynamic import, so
 * that the static `@modelcontextprotocol/sdk` imports below are only resolved
 * when the MCP server is actually started.
 *
 * `@modelcontextprotocol/sdk` is an OPTIONAL peer dependency (declared in
 * package.json). `zod` (used by the tool schemas) is NOT declared by bunqueue
 * at all — it resolves transitively from the SDK, which hard-depends on
 * `zod: "^3.25 || ^4.0"`. Queue-only consumers download neither. If a future
 * SDK major drops or peer-izes zod, declare zod explicitly here.
 * See ./index.ts for the install-hint guard when the SDK is absent.
 *
 * Transport: stdio by default; BUNQUEUE_MCP_TRANSPORT=http serves Streamable HTTP
 * instead (see ./httpTransport.ts and ./transportConfig.ts).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION } from '../shared/version';
import { createBackend } from './adapter';
import { HttpHandlerRegistry, handlerConnectionFromEnv } from './httpHandler';
import { startHttpTransport, type HttpTransportHandle } from './httpTransport';
import { createMcpServer } from './serverFactory';
import { resolveToolSettings } from './toolSetup';
import { transportConfigFromEnv } from './transportConfig';
import { mcpTracker } from './tools/mcpTracker';
import { CloudAgent } from '../infrastructure/cloud/cloudAgent';
import { getSharedManager } from '../client/manager';

export async function run(): Promise<void> {
  // Validate the transport settings before opening the backend or binding a socket
  const transportConfig = transportConfigFromEnv();
  const backend = await createBackend();
  const mode = process.env.BUNQUEUE_MODE ?? 'embedded';

  // In TCP mode HTTP handlers process jobs on the remote broker, never in a local database
  const handlerRegistry = new HttpHandlerRegistry(handlerConnectionFromEnv());
  // The opt-in tool settings are validated before binding. In http mode the first
  // server is never connected: every session builds its own from the same settings.
  let server: McpServer;
  let http: HttpTransportHandle | null = null;
  try {
    const settings = resolveToolSettings(backend);
    const createServer = () => createMcpServer(backend, handlerRegistry, { settings });
    server = createServer();
    if (transportConfig.kind === 'http') {
      http = startHttpTransport({ ...transportConfig, createServer });
    }
  } catch (err) {
    handlerRegistry.shutdown();
    backend.shutdown();
    throw err;
  }

  // Start Cloud agent for MCP telemetry (embedded mode only)
  let cloudAgent: CloudAgent | null = null;
  if (mode === 'embedded' && process.env.BUNQUEUE_CLOUD_URL) {
    const manager = getSharedManager();
    cloudAgent = CloudAgent.create(manager);
    if (cloudAgent) {
      cloudAgent.setServerHandles({
        getConnectionCount: () => 0,
        getWsClientCount: () => 0,
        getSseClientCount: () => 0,
        getMcpOperations: () => {
          // IMPORTANT: getSummary() MUST be called before drain() — drain empties the buffer
          const summary = mcpTracker.getSummary();
          const operations = mcpTracker.drain();
          return { operations, summary };
        },
      });
    }
  }

  // Graceful shutdown — close HTTP sessions and stop the HTTP server (awaiting
  // in-flight requests), then let the backend and transport flush before exit
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      if (http) await http.close();
      if (cloudAgent) await cloudAgent.stop();
      handlerRegistry.shutdown();
      backend.shutdown();
      await server.close();
    } catch {
      // Ignore cleanup errors during shutdown
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (http) {
    process.stderr.write(
      `bunqueue MCP server started (mode: ${mode}, transport: http, url: ${http.url}, version: ${VERSION})\n`
    );
    return;
  }

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`bunqueue MCP server started (mode: ${mode}, version: ${VERSION})\n`);
}
