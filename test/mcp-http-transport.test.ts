/**
 * MCP Streamable HTTP transport (BUNQUEUE_MCP_TRANSPORT=http): real network on
 * 127.0.0.1 with ephemeral ports, the embedded backend and the SDK client. Covers
 * per-session servers, bearer auth, DNS-rebinding protection, session lifecycle
 * (404/400/DELETE/cap/idle TTL), config validation and the real bin over HTTP.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ElicitRequestSchema,
  LATEST_PROTOCOL_VERSION,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { shutdownManager } from '../src/client/manager';
import { EmbeddedBackend } from '../src/mcp/adapter';
import { HttpHandlerRegistry } from '../src/mcp/httpHandler';
import {
  MAX_REQUEST_BODY_BYTES,
  startHttpTransport,
  type HttpTransportOptions,
} from '../src/mcp/httpTransport';
import { createMcpServer } from '../src/mcp/serverFactory';
import {
  HTTP_TRANSPORT_DEFAULTS,
  isLoopbackHost,
  transportConfigFromEnv,
} from '../src/mcp/transportConfig';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

let defaultTools: Promise<string[]> | null = null;

/** The default tool list of the same server factory over an in-memory link (the stdio surface). */
function defaultToolNames(): Promise<string[]> {
  defaultTools ??= (async () => {
    const handlers = new HttpHandlerRegistry();
    const server = createMcpServer(new EmbeddedBackend(), handlers, { env: {} });
    const client = new Client({ name: 'reference', version: '1.0.0' });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    await client.close();
    handlers.shutdown();
    return names;
  })();
  return defaultTools;
}

type StartOptions = Partial<Omit<HttpTransportOptions, 'createServer'>> & {
  env?: Record<string, string>;
};

/** A transport on 127.0.0.1:0 over a fresh embedded backend, torn down after each test. */
function startHttp(options: StartOptions = {}) {
  const { env = {}, ...rest } = options;
  shutdownManager();
  const backend = new EmbeddedBackend();
  const handlers = new HttpHandlerRegistry();
  const http = startHttpTransport({
    host: '127.0.0.1',
    port: 0,
    createServer: () => createMcpServer(backend, handlers, { env }),
    ...rest,
  });
  cleanups.push(async () => {
    await http.close();
    handlers.shutdown();
    backend.shutdown();
    shutdownManager();
  });
  return http;
}

async function connect(
  url: string,
  headers: Record<string, string> = {},
  elicit?: (message: string) => ElicitResult
) {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  const client = new Client(
    { name: 'http-test', version: '1.0.0' },
    { capabilities: elicit ? { elicitation: { form: {} } } : {} }
  );
  if (elicit) client.setRequestHandler(ElicitRequestSchema, (req) => elicit(req.params.message));
  await client.connect(transport);
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    return { isError: result.isError === true, json: JSON.parse(text) as Record<string, unknown> };
  };
  const toolNames = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  return { client, transport, call, toolNames };
}

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'raw', version: '1.0.0' },
  },
};

/** A raw MCP POST (initialize unless `body` is given) for status-level assertions. */
function rawPost(
  url: string,
  headers: Record<string, string> = {},
  body: unknown = initializeBody
) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await Bun.sleep(10);
  }
}

describe('MCP over Streamable HTTP', () => {
  test('lists every tool (75 by default) and runs add_job then get_job', async () => {
    const http = startHttp();
    expect(http.url).toBe(`http://127.0.0.1:${http.port}/mcp`);
    const mcp = await connect(http.url);
    const names = await mcp.toolNames();
    expect(names).toEqual(await defaultToolNames());
    expect(names.length).toBeGreaterThanOrEqual(75);

    const added = await mcp.call('bunqueue_add_job', {
      queue: 'http-q',
      name: 'n',
      data: { a: 1 },
    });
    expect(added.isError).toBe(false);
    const job = await mcp.call('bunqueue_get_job', { jobId: added.json.jobId });
    expect(job.isError).toBe(false);
    expect(job.json.queue).toBe('http-q');
    expect(job.json.data).toEqual({ a: 1 });
  });

  test('concurrent clients get independent sessions and servers', async () => {
    const http = startHttp({ env: { BUNQUEUE_MCP_TOOLSETS: 'dynamic' } });
    const [a, b] = await Promise.all([connect(http.url), connect(http.url)]);
    expect(a.transport.sessionId).toBeDefined();
    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
    expect(http.sessionCount()).toBe(2);

    const catalog = ['bunqueue_call_tool', 'bunqueue_enable_toolsets'];
    expect(await a.toolNames()).toEqual(catalog);
    expect((await a.call('bunqueue_enable_toolsets', { toolsets: ['dlq'] })).isError).toBe(false);
    expect((await a.toolNames()).length).toBeGreaterThan(catalog.length);
    expect(await b.toolNames()).toEqual(catalog);
  });

  test('server-to-client requests (confirmation elicitation) work within a session', async () => {
    const http = startHttp({ env: { BUNQUEUE_MCP_CONFIRM: 'destructive' } });
    const prompts: string[] = [];
    const mcp = await connect(http.url, {}, (message) => {
      prompts.push(message);
      return { action: 'accept', content: { confirm: true } };
    });
    for (let i = 0; i < 2; i++) {
      await mcp.call('bunqueue_add_job', { queue: 'mail', name: `j${i}`, data: {} });
    }
    const result = await mcp.call('bunqueue_obliterate_queue', { queue: 'mail' });
    expect(result.isError).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('2 waiting');
  });
});

describe('authentication', () => {
  test('missing or wrong bearer token gets 401, any configured token works', async () => {
    const http = startHttp({ tokens: ['secret-one', 'secret-two'] });

    const missing = await rawPost(http.url);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toStartWith('Bearer');
    const wrong = await rawPost(http.url, { Authorization: 'Bearer secret-three' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toContain('invalid_token');
    expect((await rawPost(http.url, { Authorization: 'Basic secret-one' })).status).toBe(401);
    expect(http.sessionCount()).toBe(0);

    await expect(connect(http.url)).rejects.toThrow();
    const mcp = await connect(http.url, { Authorization: 'Bearer secret-two' });
    expect(await mcp.toolNames()).toEqual(await defaultToolNames());
  });

  test('refuses a non-loopback host without a token, before binding', () => {
    expect(() => startHttp({ host: '0.0.0.0' })).toThrow(/non-loopback/);
    expect(() =>
      transportConfigFromEnv({ BUNQUEUE_MCP_TRANSPORT: 'http', BUNQUEUE_MCP_HTTP_HOST: '10.1.2.3' })
    ).toThrow(/BUNQUEUE_MCP_HTTP_TOKEN/);
    const withToken = transportConfigFromEnv({
      BUNQUEUE_MCP_TRANSPORT: 'http',
      BUNQUEUE_MCP_HTTP_HOST: '0.0.0.0',
      BUNQUEUE_MCP_HTTP_TOKEN: 'a, b',
    });
    expect(withToken).toMatchObject({ kind: 'http', host: '0.0.0.0', tokens: ['a', 'b'] });

    for (const host of [
      '127.0.0.1',
      '127.8.9.10',
      'localhost',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ['0.0.0.0', '10.0.0.1', '128.0.0.1', '127.0.0.256', 'example.com', '::']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('DNS-rebinding protection', () => {
  test('a forged Host or a foreign Origin gets 403', async () => {
    const http = startHttp();
    expect((await rawPost(http.url, { Host: `evil.example:${http.port}` })).status).toBe(403);
    expect((await rawPost(http.url, { Host: '127.0.0.1:1' })).status).toBe(403);
    expect((await rawPost(http.url, { Origin: 'http://evil.example' })).status).toBe(403);
    expect(http.sessionCount()).toBe(0);

    // Loopback aliases on the bound port, and the server's own origin, are accepted.
    const viaLocalhost = await rawPost(http.url, {
      Host: `localhost:${http.port}`,
      Origin: `http://localhost:${http.port}`,
    });
    expect(viaLocalhost.status).toBe(200);
    await viaLocalhost.body?.cancel();
  });

  test('extra hosts and origins can be allowed for a reverse proxy', async () => {
    const http = startHttp({
      allowedHosts: ['mcp.example.com', 'other.example.com:8443'],
      allowedOrigins: ['https://app.example.com'],
    });
    const status = async (headers: Record<string, string>) => {
      const res = await rawPost(http.url, headers, { jsonrpc: '2.0', id: 1, method: 'ping' });
      await res.body?.cancel();
      return res.status;
    };
    // Past the guard, a ping without a session is a 400, not a 403.
    expect(await status({ Host: 'mcp.example.com' })).toBe(400);
    expect(await status({ Host: 'MCP.example.com:443' })).toBe(400);
    expect(await status({ Host: 'other.example.com:8443' })).toBe(400);
    expect(await status({ Host: 'other.example.com:8444' })).toBe(403);
    expect(await status({ Origin: 'https://app.example.com' })).toBe(400);
    expect(await status({ Origin: 'https://evil.example.com' })).toBe(403);
  });
});

describe('session lifecycle', () => {
  test('unknown session 404, missing session 400, other path 404, other method 405', async () => {
    const http = startHttp();
    const ping = { jsonrpc: '2.0', id: 2, method: 'ping' };
    const unknown = await rawPost(http.url, { 'Mcp-Session-Id': crypto.randomUUID() }, ping);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: number } }).error.code).toBe(-32001);
    expect((await rawPost(http.url, {}, ping)).status).toBe(400);
    expect((await fetch(http.url, { headers: { Accept: 'text/event-stream' } })).status).toBe(400);
    expect((await rawPost(http.url.replace('/mcp', '/other'))).status).toBe(404);
    expect((await fetch(http.url, { method: 'PUT' })).status).toBe(405);
    expect((await rawPost(http.url, {}, 'not json{')).status).toBe(400);
  });

  test('a rejected initialize leaves no session; oversized bodies get 413', async () => {
    const http = startHttp();
    const notAcceptable = await rawPost(http.url, { Accept: 'application/json' });
    expect(notAcceptable.status).toBe(406);
    expect(http.sessionCount()).toBe(0);

    const huge = { ...initializeBody, padding: 'x'.repeat(MAX_REQUEST_BODY_BYTES) };
    expect((await rawPost(http.url, {}, huge)).status).toBe(413);
    expect(http.sessionCount()).toBe(0);
  });

  test('DELETE ends the session', async () => {
    const http = startHttp();
    const mcp = await connect(http.url);
    const sessionId = mcp.transport.sessionId as string;
    expect(http.sessionCount()).toBe(1);

    await mcp.transport.terminateSession();
    expect(http.sessionCount()).toBe(0);
    const after = await rawPost(
      http.url,
      { 'Mcp-Session-Id': sessionId },
      { jsonrpc: '2.0', id: 3, method: 'ping' }
    );
    expect(after.status).toBe(404);
  });

  test('initialize beyond the session cap gets 503 until a session ends', async () => {
    const http = startHttp({ maxSessions: 1 });
    const first = await connect(http.url);

    const refused = await rawPost(http.url);
    expect(refused.status).toBe(503);
    const body = (await refused.json()) as { jsonrpc: string; error: { message: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.message).toContain('session limit');

    await first.transport.terminateSession();
    const second = await connect(http.url);
    expect(await second.toolNames()).toEqual(await defaultToolNames());
  });

  test('an idle session expires after the TTL, a busy one does not', async () => {
    // The TTL leaves a wide margin between the end of the busy request and the
    // sessionCount() check below, so a slow event loop cannot sweep the session first.
    const http = startHttp({ sessionTtlMs: 500 });
    const mcp = await connect(http.url);
    const sessionId = mcp.transport.sessionId as string;
    const added = await mcp.call('bunqueue_add_job', { queue: 'ttl-q', name: 'n', data: {} });

    // A request outliving the TTL keeps its session alive until it is answered.
    const waited = await mcp.call('bunqueue_wait_for_job', {
      jobId: added.json.jobId,
      timeoutMs: 1500,
    });
    expect(waited.json.completed).toBe(false);
    expect(http.sessionCount()).toBe(1);

    await waitFor(() => http.sessionCount() === 0);
    const after = await rawPost(
      http.url,
      { 'Mcp-Session-Id': sessionId },
      { jsonrpc: '2.0', id: 4, method: 'ping' }
    );
    expect(after.status).toBe(404);
  });

  test('close() ends open sessions and stops the server', async () => {
    const http = startHttp();
    await connect(http.url);
    expect(http.sessionCount()).toBe(1);
    await http.close();
    expect(http.sessionCount()).toBe(0);
    await expect(rawPost(http.url)).rejects.toThrow();
  });
});

describe('configuration', () => {
  test('defaults to stdio; http defaults are applied', () => {
    expect(transportConfigFromEnv({})).toEqual({ kind: 'stdio' });
    expect(transportConfigFromEnv({ BUNQUEUE_MCP_TRANSPORT: ' STDIO ' })).toEqual({
      kind: 'stdio',
    });
    expect(transportConfigFromEnv({ BUNQUEUE_MCP_TRANSPORT: 'http' })).toEqual({
      kind: 'http',
      ...HTTP_TRANSPORT_DEFAULTS,
      tokens: [],
      allowedHosts: [],
      allowedOrigins: [],
    });
    expect(
      transportConfigFromEnv({
        BUNQUEUE_MCP_TRANSPORT: 'http',
        BUNQUEUE_MCP_HTTP_HOST: '[::1]',
        BUNQUEUE_MCP_HTTP_PORT: '0',
        BUNQUEUE_MCP_HTTP_PATH: '/api/mcp/',
        BUNQUEUE_MCP_HTTP_MAX_SESSIONS: '5',
        BUNQUEUE_MCP_HTTP_SESSION_TTL_MS: '60000',
        BUNQUEUE_MCP_HTTP_ALLOWED_HOSTS: 'MCP.example.com, [::1]:9000',
        BUNQUEUE_MCP_HTTP_ALLOWED_ORIGINS: 'https://app.example.com/',
      })
    ).toMatchObject({
      host: '::1',
      port: 0,
      path: '/api/mcp',
      maxSessions: 5,
      sessionTtlMs: 60000,
      allowedHosts: ['mcp.example.com', '[::1]:9000'],
      allowedOrigins: ['https://app.example.com'],
    });
  });

  test('invalid values throw', () => {
    const http = (extra: Record<string, string>) => () =>
      transportConfigFromEnv({ BUNQUEUE_MCP_TRANSPORT: 'http', ...extra });
    expect(() => transportConfigFromEnv({ BUNQUEUE_MCP_TRANSPORT: 'sse' })).toThrow(
      /BUNQUEUE_MCP_TRANSPORT/
    );
    for (const port of ['70000', '-1', 'abc', '1.5', '65536']) {
      expect(http({ BUNQUEUE_MCP_HTTP_PORT: port })).toThrow(/BUNQUEUE_MCP_HTTP_PORT/);
    }
    for (const value of ['0', '-3', 'many']) {
      expect(http({ BUNQUEUE_MCP_HTTP_MAX_SESSIONS: value })).toThrow(/MAX_SESSIONS/);
      expect(http({ BUNQUEUE_MCP_HTTP_SESSION_TTL_MS: value })).toThrow(/SESSION_TTL_MS/);
    }
    expect(http({ BUNQUEUE_MCP_HTTP_PATH: 'mcp' })).toThrow(/BUNQUEUE_MCP_HTTP_PATH/);
    expect(http({ BUNQUEUE_MCP_HTTP_PATH: '/mcp?x=1' })).toThrow(/BUNQUEUE_MCP_HTTP_PATH/);
    expect(http({ BUNQUEUE_MCP_HTTP_HOST: '127.0.0.1:80' })).toThrow(/BUNQUEUE_MCP_HTTP_HOST/);
    expect(http({ BUNQUEUE_MCP_HTTP_HOST: 'bad host' })).toThrow(/BUNQUEUE_MCP_HTTP_HOST/);
    expect(http({ BUNQUEUE_MCP_HTTP_TOKEN: ' , ' })).toThrow(/BUNQUEUE_MCP_HTTP_TOKEN/);
    expect(http({ BUNQUEUE_MCP_HTTP_ALLOWED_HOSTS: 'https://x.example' })).toThrow(/ALLOWED_HOSTS/);
    expect(http({ BUNQUEUE_MCP_HTTP_ALLOWED_ORIGINS: 'x.example' })).toThrow(/ALLOWED_ORIGINS/);
    expect(http({ BUNQUEUE_MCP_HTTP_ALLOWED_ORIGINS: 'https://x.example/p' })).toThrow(
      /ALLOWED_ORIGINS/
    );
  });
});

describe('bunqueue-mcp bin', () => {
  const binEnv = (extra: Record<string, string>) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(BUNQUEUE_|BQ_|DATA_PATH$|SQLITE_PATH$)/.test(key)) {
        env[key] = value;
      }
    }
    return { ...env, ...extra };
  };

  function spawnBin(extra: Record<string, string>) {
    const proc = Bun.spawn([process.execPath, 'src/mcp/index.ts'], {
      cwd: `${import.meta.dir}/..`,
      env: binEnv(extra),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    cleanups.push(async () => {
      proc.kill('SIGKILL');
      await proc.exited;
    });
    return proc;
  }

  /** Read stderr until `pattern` matches (or the stream ends / times out). */
  async function readStderr(proc: ReturnType<typeof spawnBin>, pattern: RegExp) {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 15_000;
    try {
      while (!pattern.test(text) && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now())]);
        if (!chunk || chunk.done) break;
        text += decoder.decode(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    return text;
  }

  test('serves HTTP from the real bin and exits 0 on SIGTERM', async () => {
    const proc = spawnBin({ BUNQUEUE_MCP_TRANSPORT: 'http', BUNQUEUE_MCP_HTTP_PORT: '0' });
    const stderr = await readStderr(proc, /url: (\S+),/);
    expect(stderr).toMatch(
      /bunqueue MCP server started \(mode: embedded, transport: http, url: http:\/\/127\.0\.0\.1:\d+\/mcp, version: /
    );
    const url = (/url: (\S+),/.exec(stderr) as RegExpExecArray)[1];
    const mcp = await connect(url);
    expect(await mcp.toolNames()).toEqual(await defaultToolNames());

    // The session (and its open SSE stream) is still live when the signal arrives.
    proc.kill('SIGTERM');
    expect(await proc.exited).toBe(0);
  }, 30_000);

  test('stdio stays the default with the historical startup line', async () => {
    const proc = spawnBin({});
    const stderr = await readStderr(proc, /server started/);
    expect(stderr).toMatch(/bunqueue MCP server started \(mode: embedded, version: [^,)]+\)/);
    proc.kill('SIGTERM');
    expect(await proc.exited).toBe(0);
  }, 30_000);

  test('a port already in use aborts startup with a fatal error', async () => {
    const occupied = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    cleanups.push(() => occupied.stop(true));
    const proc = spawnBin({
      BUNQUEUE_MCP_TRANSPORT: 'http',
      BUNQUEUE_MCP_HTTP_PORT: String(occupied.port),
    });
    const stderr = await readStderr(proc, /Fatal error/);
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain('Fatal error');
    expect(stderr).not.toContain('server started');
  }, 30_000);

  test('an invalid transport aborts startup with a fatal error', async () => {
    const proc = spawnBin({ BUNQUEUE_MCP_TRANSPORT: 'websocket' });
    const stderr = await readStderr(proc, /Fatal error/);
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain('Fatal error: BUNQUEUE_MCP_TRANSPORT must be stdio or http');
    expect(stderr).not.toContain('Fatal error: Error:');
  }, 30_000);
});
