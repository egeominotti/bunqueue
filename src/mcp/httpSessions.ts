/**
 * Stateful session registry for the MCP Streamable HTTP transport.
 *
 * An McpServer can be connected to one transport only, so every session gets its
 * own server (from the factory) and its own WebStandardStreamableHTTPServerTransport;
 * they all share the backend and handler registry captured by the factory. The
 * registry bounds concurrent sessions and closes sessions idle for longer than the
 * TTL. A session is idle when it has received no request, sent no message and has
 * no request still awaiting its response for the whole TTL.
 */

import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import { jsonRpcError } from './httpSecurity';

export interface HttpSession {
  readonly id: string;
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
}

interface SessionState {
  session?: HttpSession;
  lastActivity: number;
  /** Client request ids still awaiting a response; a busy session is never idle. */
  pending: Set<RequestId>;
}

export interface SessionRegistryOptions {
  createServer: () => McpServer;
  maxSessions: number;
  sessionTtlMs: number;
  /** Test seam for the idle clock. */
  now?: () => number;
}

export class HttpSessionRegistry {
  private readonly sessions = new Map<string, SessionState>();
  private readonly now: () => number;
  private readonly sweeper: ReturnType<typeof setInterval>;
  /** Sessions whose initialize request is still being handled (count toward the cap). */
  private opening = 0;
  private closed = false;

  constructor(private readonly options: SessionRegistryOptions) {
    this.now = options.now ?? Date.now;
    const interval = Math.min(Math.max(Math.floor(options.sessionTtlMs / 2), 10), 60_000);
    this.sweeper = setInterval(() => void this.sweep(), interval);
    this.sweeper.unref?.();
  }

  get size(): number {
    return this.sessions.size;
  }

  /** The live session for an id, refreshing its idle clock; undefined when unknown. */
  get(id: string): HttpSession | undefined {
    const state = this.sessions.get(id);
    if (!state?.session) return undefined;
    state.lastActivity = this.now();
    return state.session;
  }

  /** Create a session for an initialize request and let its transport answer it. */
  async initialize(req: Request, parsedBody: unknown): Promise<Response> {
    if (this.closed)
      return jsonRpcError(503, -32000, 'Service unavailable: server is shutting down');
    if (this.sessions.size + this.opening >= this.options.maxSessions) {
      return jsonRpcError(
        503,
        -32000,
        `Service unavailable: session limit reached (${this.options.maxSessions})`,
        { 'Retry-After': '1' }
      );
    }
    this.opening++;
    let server: McpServer | null = null;
    try {
      server = this.options.createServer();
      const transport = this.track(server);
      await server.connect(transport);
      const response = await transport.handleRequest(req, { parsedBody });
      // Rejected before initialization (406/415/400): nothing was registered.
      if (transport.sessionId === undefined) await server.close();
      // Shutdown began while this session was being created: do not outlive closeAll().
      else if (this.closed) await this.close(transport.sessionId);
      return response;
    } catch (err) {
      await server?.close().catch(() => undefined);
      throw err;
    } finally {
      this.opening--;
    }
  }

  /** Close one session (transport streams first, then the server). */
  async close(id: string): Promise<void> {
    const state = this.sessions.get(id);
    this.sessions.delete(id);
    await state?.session?.server.close().catch(() => undefined);
  }

  /** Close sessions idle for at least the TTL; returns how many were closed. */
  async sweep(): Promise<number> {
    const now = this.now();
    const expired: string[] = [];
    for (const [id, state] of this.sessions) {
      if (state.pending.size === 0 && now - state.lastActivity >= this.options.sessionTtlMs) {
        expired.push(id);
      }
    }
    await Promise.all(expired.map((id) => this.close(id)));
    return expired.length;
  }

  /** Refuse new sessions, stop the sweeper and close every session. */
  async closeAll(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  /** A transport wired to this registry: registration, removal and activity tracking. */
  private track(server: McpServer): WebStandardStreamableHTTPServerTransport {
    const state: SessionState = { lastActivity: this.now(), pending: new Set() };
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        state.session = { id, server, transport };
        state.lastActivity = this.now();
        this.sessions.set(id, state);
      },
    });
    // Set before connect(): Protocol chains these, so they run ahead of its own handlers.
    // onclose fires on DELETE, on server.close() and on registry close alike.
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined && this.sessions.get(id) === state) this.sessions.delete(id);
    };
    transport.onmessage = (message) => {
      state.lastActivity = this.now();
      if (isJSONRPCRequest(message)) state.pending.add(message.id);
      else if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
        const requestId = (message.params as { requestId?: RequestId } | undefined)?.requestId;
        if (requestId !== undefined) state.pending.delete(requestId);
      }
    };
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      state.lastActivity = this.now();
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        if (message.id !== undefined) state.pending.delete(message.id);
      }
      return send(message, options);
    };
    return transport;
  }
}
