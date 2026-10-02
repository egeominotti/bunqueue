/**
 * Reproduces a confirmation lost over the Streamable HTTP transport (pre-commit review).
 *
 * BUNQUEUE_MCP_CONFIRM asks the user through MCP elicitation. Over HTTP a server request
 * sent without `relatedRequestId` travels only on the optional standalone GET stream; a
 * client that declared elicitation but never opened that stream (it is optional in the
 * spec) never saw the question, and the guarded call hung until the elicitation timed
 * out and was then refused as "not confirmed". The question must travel on the POST
 * response stream of the tool call that triggered it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { shutdownManager } from '../src/client/manager';
import { EmbeddedBackend } from '../src/mcp/adapter';
import { HttpHandlerRegistry } from '../src/mcp/httpHandler';
import { startHttpTransport } from '../src/mcp/httpTransport';
import { createMcpServer } from '../src/mcp/serverFactory';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

type Message = Record<string, unknown> & { id?: number | string; method?: string };

/** Reads JSON-RPC messages from an SSE response body, one at a time. */
function sseReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const queue: Message[] = [];
  return {
    async next(timeoutMs: number): Promise<Message | null> {
      const deadline = Date.now() + timeoutMs;
      while (queue.length === 0) {
        const left = deadline - Date.now();
        if (left <= 0) return null;
        const chunk = await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]);
        if (!chunk || chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = event
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('');
          if (data) queue.push(JSON.parse(data) as Message);
        }
      }
      return queue.shift() ?? null;
    },
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

describe('HTTP transport: confirmation without a standalone GET stream', () => {
  test('the elicitation travels on the tool call response stream', async () => {
    shutdownManager();
    const backend = new EmbeddedBackend();
    const handlers = new HttpHandlerRegistry();
    const env = { BUNQUEUE_MCP_CONFIRM: 'destructive' };
    const http = startHttpTransport({
      host: '127.0.0.1',
      port: 0,
      createServer: () => createMcpServer(backend, handlers, { env }),
    });
    cleanups.push(async () => {
      await http.close();
      handlers.shutdown();
      backend.shutdown();
      shutdownManager();
    });
    await backend.addJob('billing', 'n', { i: 1 });

    const baseHeaders = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const init = await fetch(http.url, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { elicitation: { form: {} } },
          clientInfo: { name: 'no-get-stream', version: '1.0.0' },
        },
      }),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id') ?? '';
    const initReader = sseReader(init.body!);
    const initResult = await initReader.next(5000);
    void initReader.cancel();
    const version = String(
      (initResult?.result as { protocolVersion?: string } | undefined)?.protocolVersion
    );
    const headers = {
      ...baseHeaders,
      'mcp-session-id': sessionId,
      'mcp-protocol-version': version,
    };
    const post = (body: unknown) =>
      fetch(http.url, { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);

    // No GET stream is ever opened by this client.
    const call = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'bunqueue_obliterate_queue', arguments: { queue: 'billing' } },
    });
    expect(call.status).toBe(200);
    const stream = sseReader(call.body!);
    cleanups.push(() => stream.cancel());

    const question = await stream.next(3000);
    expect(question?.method).toBe('elicitation/create');

    const answered = await post({
      jsonrpc: '2.0',
      id: question!.id,
      result: { action: 'accept', content: { confirm: true } },
    });
    expect(answered.status).toBe(202);

    const reply = await stream.next(5000);
    expect(reply?.id).toBe(2);
    expect((reply?.result as { isError?: boolean } | undefined)?.isError).not.toBe(true);
    expect((await backend.getJobCounts('billing')).waiting).toBe(0);
  }, 20_000);
});
