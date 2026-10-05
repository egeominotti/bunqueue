#!/usr/bin/env bun
/**
 * bunqueue MCP Server
 *
 * Model Context Protocol server for bunqueue job queue management.
 * Uses the official @modelcontextprotocol/sdk for protocol compliance.
 *
 * Supports two connection modes:
 * - embedded (default): In-memory or direct SQLite access via QueueManager
 * - tcp: Connect to a remote memory/SQLite or PostgreSQL-backed server
 *
 * @example Embedded mode (Claude Desktop):
 * ```json
 * {
 *   "mcpServers": {
 *     "bunqueue": {
 *       "command": "bunx",
 *       "args": ["--package=bunqueue", "bunqueue-mcp"],
 *       "env": { "DATA_PATH": "./data/bunq.db" }
 *     }
 *   }
 * }
 * ```
 *
 * @example TCP mode (remote server):
 * ```json
 * {
 *   "mcpServers": {
 *     "bunqueue": {
 *       "command": "bunx",
 *       "args": ["--package=bunqueue", "bunqueue-mcp"],
 *       "env": {
 *         "BUNQUEUE_MODE": "tcp",
 *         "BUNQUEUE_HOST": "localhost",
 *         "BUNQUEUE_PORT": "6789",
 *         "BUNQUEUE_TOKEN": "secret"
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * Two transports, independent of the connection mode:
 * - stdio (default): one client over stdin/stdout, as in the examples above
 * - http (opt-in): MCP Streamable HTTP for several concurrent clients, one
 *   session each, sharing a single backend
 *
 * @example Streamable HTTP transport (binds 127.0.0.1:6791, path /mcp):
 * ```sh
 * BUNQUEUE_MCP_TRANSPORT=http BUNQUEUE_MCP_HTTP_TOKEN=secret bunx --package=bunqueue bunqueue-mcp
 * # stderr: bunqueue MCP server started (mode: embedded, transport: http,
 * #         url: http://127.0.0.1:6791/mcp, version: X)
 * ```
 * Clients send `Authorization: Bearer secret`. A non-loopback
 * BUNQUEUE_MCP_HTTP_HOST requires BUNQUEUE_MCP_HTTP_TOKEN.
 */

// The MCP server implementation lives in ./server.ts and is loaded LAZILY via
// dynamic import below. This keeps `@modelcontextprotocol/sdk` (and its zod
// sub-dependency) out of this entrypoint's static import graph, so they can be
// an OPTIONAL peer dependency: queue-only consumers of bunqueue never download
// the SDK + zod + its HTTP stack (~24 MB). If a user starts `bunqueue-mcp`
// without the SDK installed, the guard below prints an actionable install hint.

async function launch(): Promise<void> {
  try {
    const mod = await import('./server.js');
    await mod.run();
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    const msg = String(e?.message ?? err);
    const isModuleNotFound =
      e?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/i.test(msg);
    const mentionsMcpDeps = /@modelcontextprotocol\/sdk|(^|\W)zod(\W|$)/i.test(msg);

    if (isModuleNotFound && mentionsMcpDeps) {
      process.stderr.write(
        '[bunqueue-mcp] The MCP server requires "@modelcontextprotocol/sdk" (an optional peer dependency).\n' +
          'Install it with:  bun add @modelcontextprotocol/sdk\n'
      );
      process.exit(1);
    }

    // The message only, as the server entry points print it: `${err}` would prefix
    // the class name ("Fatal error: Error: ...", "Fatal error: ConfigError: ...").
    process.stderr.write(`Fatal error: ${msg}\n`);
    process.exit(1);
  }
}

void launch();
