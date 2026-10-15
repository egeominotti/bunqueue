import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { QueueManager } from '../../src/application/queueManager';
import { getSharedManager, peekSharedManager, shutdownManager } from '../../src/client/manager';
import { createTcpServer } from '../../src/infrastructure/server/tcp';
import { EmbeddedBackend, TcpBackend, type McpBackend } from '../../src/mcp/adapter';
import { HttpHandlerRegistry } from '../../src/mcp/httpHandler';
import { createMcpServer } from '../../src/mcp/serverFactory';
import type { CallRecord, EvalMode, ToolReply } from './task-types';

/** Sequential, standalone evaluation only: never replace an application's shared manager. */
export async function openTaskHarness(mode: EvalMode, env: Record<string, string> = {}) {
  if (peekSharedManager()) throw new Error('Task evaluation requires no active embedded manager');
  const dir = mkdtempSync(join(tmpdir(), 'bunqueue-task-eval-'));
  let backend: McpBackend | undefined;
  let broker: QueueManager | undefined;
  let tcp: ReturnType<typeof createTcpServer> | undefined;
  let handlers: HttpHandlerRegistry | undefined;
  let client: Client | undefined;
  let server: ReturnType<typeof createMcpServer> | undefined;
  const calls: CallRecord[] = [];
  let responseBytes = 0;
  const close = async () => {
    const errors: unknown[] = [];
    const steps = [
      () => client?.close(),
      () => server?.close(),
      () => handlers?.shutdown(),
      () => backend?.shutdown(),
      () => tcp?.stop(),
      () => broker?.shutdown(),
      () => {
        if (mode === 'embedded') shutdownManager();
      },
      () => rmSync(dir, { recursive: true, force: true }),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Task fixture cleanup failed');
  };
  try {
    if (mode === 'tcp') {
      broker = new QueueManager({ dataPath: join(dir, 'broker.db') });
      tcp = createTcpServer(broker, { port: 0, hostname: '127.0.0.1' });
      const connection = { host: '127.0.0.1', port: tcp.server.port };
      const remote = new TcpBackend(connection);
      backend = remote;
      await remote.connect();
      handlers = new HttpHandlerRegistry(connection);
    } else {
      getSharedManager(join(dir, 'embedded.db'));
      backend = new EmbeddedBackend();
      handlers = new HttpHandlerRegistry();
    }
    server = createMcpServer(backend, handlers, { env, decision: null });
    client = new Client({ name: 'bunqueue-offline-task-eval', version: '1' });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    const connected = client;
    return {
      backend,
      dir,
      calls,
      responseBytes: () => responseBytes,
      listTools: async () => {
        const result = await connected.listTools();
        responseBytes += Buffer.byteLength(JSON.stringify(result));
        return result.tools;
      },
      call: async (name: string, args: Record<string, unknown> = {}): Promise<ToolReply> => {
        const result = await connected.callTool({ name, arguments: args });
        const bytes = Buffer.byteLength(JSON.stringify(result));
        responseBytes += bytes;
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text;
        const envelope = result.structuredContent as
          | { outcome: string; data: Record<string, unknown> }
          | undefined;
        let legacy: Record<string, unknown> = {};
        if (!envelope && text) {
          try {
            legacy = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // SDK input validation errors retain their unstructured text contract.
            legacy = { error: text };
          }
        }
        const reply = {
          isError: result.isError === true,
          outcome: envelope?.outcome,
          data: envelope?.data ?? legacy,
        };
        const dispatched = name === 'bunqueue_call_tool' && typeof args.name === 'string';
        calls.push({
          name: dispatched ? (args.name as string) : name,
          args: dispatched ? ((args.arguments as Record<string, unknown>) ?? {}) : args,
          reply,
          responseBytes: bytes,
        });
        return reply;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
