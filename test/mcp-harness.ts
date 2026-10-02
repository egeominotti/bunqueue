/**
 * Shared harness for MCP tests: the real tool setup and a real MCP client over an
 * in-memory transport, backed either by the embedded engine or by a TcpBackend talking
 * to a real in-process TCP broker (fresh SQLite directory, dynamic port). Not a test file.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ElicitRequestSchema,
  ToolListChangedNotificationSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { QueueManager } from '../src/application/queueManager';
import { shutdownManager } from '../src/client/manager';
import { createTcpServer } from '../src/infrastructure/server/tcp';
import { EmbeddedBackend, TcpBackend, type McpBackend } from '../src/mcp/adapter';
import type { DecisionModel } from '../src/mcp/decisionModel';
import { HttpHandlerRegistry } from '../src/mcp/httpHandler';
import { setupTools } from '../src/mcp/toolSetup';

export type McpMode = 'embedded' | 'tcp';

export interface HarnessOptions {
  /** Backend under test (default embedded). */
  mode?: McpMode;
  env?: Record<string, string>;
  decision?: DecisionModel | null;
  /** When set, the client declares form elicitation and answers with this callback. */
  elicit?: (message: string) => ElicitResult;
}

/** A real broker behind TCP: QueueManager on a fresh SQLite dir + TCP server on port 0. */
function startBroker() {
  const dir = mkdtempSync(join(tmpdir(), 'bunqueue-mcp-tcp-'));
  const qm = new QueueManager({ dataPath: join(dir, 'broker.db') });
  const tcp = createTcpServer(qm, { port: 0, hostname: '127.0.0.1' });
  return {
    qm,
    port: tcp.server.port,
    stop: () => {
      tcp.stop();
      qm.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function startMcp(options: HarnessOptions = {}) {
  shutdownManager();
  const mode = options.mode ?? 'embedded';
  const broker = mode === 'tcp' ? startBroker() : null;
  let backend: McpBackend;
  if (broker) {
    const tcpBackend = new TcpBackend({ host: '127.0.0.1', port: broker.port });
    await tcpBackend.connect();
    backend = tcpBackend;
  } else {
    backend = new EmbeddedBackend();
  }
  const server = new McpServer({ name: 'bunqueue-mcp', version: 'test' });
  // In TCP mode HTTP handlers must process jobs on the remote broker, not locally.
  const handlers = new HttpHandlerRegistry(broker ? { host: '127.0.0.1', port: broker.port } : undefined);
  setupTools(server, backend, handlers, {
    env: options.env ?? {},
    decision: options.decision ?? null,
  });

  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: options.elicit ? { elicitation: { form: {} } } : {} }
  );
  const prompts: string[] = [];
  if (options.elicit) {
    const answer = options.elicit;
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      prompts.push(request.params.message);
      return answer(request.params.message);
    });
  }
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged++;
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text };
    }
    return { isError: result.isError === true, json, text };
  };

  return {
    mode,
    backend,
    /** The broker's QueueManager in TCP mode (direct store checks); null when embedded. */
    broker: broker?.qm ?? null,
    client,
    call,
    prompts,
    listChanged: () => listChanged,
    toolNames: async () => (await client.listTools()).tools.map((t) => t.name).sort(),
    close: async () => {
      await client.close();
      handlers.shutdown();
      backend.shutdown();
      broker?.stop();
      shutdownManager();
    },
  };
}

/** Minimal SystemOne-compatible server; `respond` returns a JSON body or a Response. */
export function fakeDecisionServer(respond: (body: Record<string, unknown>) => unknown) {
  const calls: Array<{ body: Record<string, unknown>; authorization: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ body, authorization: request.headers.get('authorization') });
      const reply = await respond(body);
      return reply instanceof Response ? reply : Response.json(reply);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1/systemone`,
    calls,
    stop: () => server.stop(true),
  };
}
