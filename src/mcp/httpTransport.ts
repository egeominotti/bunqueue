/**
 * Opt-in MCP Streamable HTTP transport (BUNQUEUE_MCP_TRANSPORT=http) on Bun.serve.
 *
 * One endpoint path serves POST (JSON-RPC in, JSON or SSE out), GET (standalone
 * SSE stream) and DELETE (end session). Every request passes, in order: the
 * DNS-rebinding guard (403), the path check (404), bearer auth (401) and method
 * check (405), then session routing: a known Mcp-Session-Id goes to its transport,
 * an unknown one gets 404, and a request without one must be an initialize POST
 * (otherwise 400), which creates a session unless the cap is reached (503).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Server } from 'bun';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createHostGuard, createTokenGuard, jsonRpcError, type RequestGuard } from './httpSecurity';
import { HttpSessionRegistry } from './httpSessions';
import { resolveHttpConfig, type HttpTransportConfig } from './transportConfig';

/** Request bodies above this are refused by Bun with 413 before reaching the handler. */
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const STOP_GRACE_MS = 5_000;
const ALLOWED_METHODS = 'GET, POST, DELETE';

export interface HttpTransportOptions extends Partial<HttpTransportConfig> {
  /** Builds a fully registered McpServer for each new session. */
  createServer: () => McpServer;
  /** Test seam: how long close() waits for in-flight requests before forcing. */
  stopGraceMs?: number;
}

export interface HttpTransportHandle {
  /** e.g. http://127.0.0.1:6791/mcp, with the actual port when 0 was requested. */
  readonly url: string;
  readonly port: number;
  /** Number of live sessions. */
  sessionCount(): number;
  /** Close every session, then stop the server (waiting for in-flight requests). */
  close(): Promise<void>;
}

const hostForUrl = (host: string) => (host.includes(':') ? `[${host}]` : host);

function containsInitialize(body: unknown): boolean {
  return Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);
}

/**
 * Validate the configuration, bind, and serve MCP over Streamable HTTP. Throws
 * before binding on invalid settings (including a non-loopback host without a
 * token). Installs no signal handlers and never exits the process.
 */
export function startHttpTransport(options: HttpTransportOptions): HttpTransportHandle {
  const { createServer, stopGraceMs = STOP_GRACE_MS, ...input } = options;
  const config = resolveHttpConfig(input);
  const sessions = new HttpSessionRegistry({
    createServer,
    maxSessions: config.maxSessions,
    sessionTtlMs: config.sessionTtlMs,
  });
  const tokenGuard = createTokenGuard(config.tokens);
  // The host guard needs the bound port, known only after Bun.serve() returns.
  let hostGuard: RequestGuard = () => jsonRpcError(503, -32000, 'Service unavailable');

  const route = async (req: Request, server: Server<undefined>): Promise<Response> => {
    const rejected = hostGuard(req);
    if (rejected) return rejected;
    if (new URL(req.url).pathname !== config.path) return jsonRpcError(404, -32000, 'Not found');
    const unauthorized = tokenGuard(req);
    if (unauthorized) return unauthorized;
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
      return jsonRpcError(405, -32000, 'Method not allowed.', { Allow: ALLOWED_METHODS });
    }
    // SSE streams and long tool calls may stay silent longer than Bun's idle timeout.
    server.timeout(req, 0);

    const sessionId = req.headers.get('mcp-session-id');
    if (sessionId !== null) {
      const session = sessions.get(sessionId);
      if (!session) return jsonRpcError(404, -32001, 'Session not found');
      return session.transport.handleRequest(req);
    }
    const missing = () =>
      jsonRpcError(400, -32000, 'Bad Request: Mcp-Session-Id header is required');
    if (req.method !== 'POST') return missing();
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonRpcError(400, -32700, 'Parse error: Invalid JSON');
    }
    return containsInitialize(body) ? sessions.initialize(req, body) : missing();
  };

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch: async (req, srv) => {
      try {
        return await route(req, srv);
      } catch (err) {
        process.stderr.write(`bunqueue MCP HTTP: request failed: ${String(err)}\n`);
        return jsonRpcError(500, -32603, 'Internal error');
      }
    },
  });

  const port = server.port ?? config.port;
  hostGuard = createHostGuard({
    host: config.host,
    port,
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
  });

  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      // Closing sessions ends their SSE streams, so the graceful stop can complete.
      await sessions.closeAll();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const graceful = server.stop(false).then(() => true);
      const expired = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), stopGraceMs);
      });
      const stopped = await Promise.race([graceful, expired]);
      clearTimeout(timer);
      if (!stopped) await server.stop(true);
    })();
    return closing;
  };

  return {
    url: `http://${hostForUrl(config.host)}:${port}${config.path}`,
    port,
    sessionCount: () => sessions.size,
    close,
  };
}
