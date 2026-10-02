/**
 * MCP workflow tools (BUNQUEUE_MCP_WORKFLOW_DB), end to end: a real TCP broker on a
 * fresh SQLite directory, a real workflow Engine connected to it over TCP with its own
 * dataPath, and the MCP server in TCP mode reading that workflow database and
 * resuming runs through the same broker. The MCP server never runs a step itself.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { QueueManager } from '../src/application/queueManager';
import { closeAllSharedPools, shutdownManager } from '../src/client';
import { Engine, Workflow, type Execution } from '../src/client/workflow';
import { WorkflowStore } from '../src/client/workflow/store';
import { createTcpServer } from '../src/infrastructure/server/tcp';
import { EmbeddedBackend, TcpBackend, type McpBackend } from '../src/mcp/adapter';
import { HttpHandlerRegistry } from '../src/mcp/httpHandler';
import { TOOL_POLICIES } from '../src/mcp/toolPolicy';
import { setupTools } from '../src/mcp/toolSetup';
import { toJsonSafe } from '../src/mcp/workflow/jsonSafe';
import { startMcp } from './mcp-harness';
import { waitForWorkflowState } from './workflowTestUtils';

setDefaultTimeout(30_000);

const WORKFLOW_TOOLS = [
  'bunqueue_get_workflow_execution',
  'bunqueue_list_workflow_executions',
  'bunqueue_signal_workflow',
];
const SIGNAL = 'bunqueue_signal_workflow';
const GET = 'bunqueue_get_workflow_execution';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  closeAllSharedPools();
  shutdownManager();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bunqueue-mcp-wf-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function startBroker(dir: string): number {
  const qm = new QueueManager({ dataPath: join(dir, 'broker.db') });
  const tcp = createTcpServer(qm, { port: 0, hostname: '127.0.0.1' });
  cleanups.push(() => {
    tcp.stop();
    qm.shutdown();
  });
  return tcp.server.port as number;
}

type Wrap = (backend: McpBackend) => McpBackend;
// oxlint-disable-next-line typescript/no-explicit-any -- tool replies are free-form JSON
type Reply = Record<string, any>;

async function connectMcp(port: number, env: Record<string, string>, wrap?: Wrap) {
  const tcpBackend = new TcpBackend({ host: '127.0.0.1', port });
  await tcpBackend.connect();
  const handlers = new HttpHandlerRegistry();
  cleanups.push(() => {
    handlers.shutdown();
    tcpBackend.shutdown();
  });
  const server = new McpServer({ name: 'bunqueue-mcp', version: 'test' });
  setupTools(server, wrap ? wrap(tcpBackend) : tcpBackend, handlers, { env, decision: null });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    return { isError: result.isError === true, json: JSON.parse(text) as Reply };
  };
  const toolNames = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  return { client, call, toolNames };
}

interface FlowOptions {
  timeout?: number;
  /** The step after the gate waits for this before returning. */
  hold?: Promise<void>;
}

/** prepare -> waitFor('approval') -> finish; `finished` records every finish run. */
function approvalFlow(name: string, finished: Map<string, unknown[]>, opts: FlowOptions = {}) {
  return new Workflow(name)
    .step('prepare', async () => ({ prepared: true }))
    .waitFor('approval', opts.timeout === undefined ? undefined : { timeout: opts.timeout })
    .step('finish', async (ctx) => {
      finished.set(ctx.executionId, [
        ...(finished.get(ctx.executionId) ?? []),
        ctx.signals.approval,
      ]);
      await opts.hold;
      return { approval: ctx.signals.approval };
    });
}

function startEngine(port: number, dataPath: string, workflow: Workflow, queueName?: string) {
  const engine = new Engine({
    embedded: false,
    connection: { host: '127.0.0.1', port, poolSize: 1 },
    dataPath,
    queueName,
    concurrency: 4,
  });
  engine.register(workflow);
  cleanups.push(() => engine.close(true).catch(() => undefined));
  return engine;
}

async function setup(
  opts: FlowOptions & { queueName?: string; env?: Record<string, string> } = {}
) {
  const dir = tempDir();
  const port = startBroker(dir);
  const dbPath = join(dir, 'workflow.db');
  const name = `approval-${crypto.randomUUID()}`;
  const finished = new Map<string, unknown[]>();
  // The Engine creates the workflow database; the MCP server only opens it.
  const engine = startEngine(port, dbPath, approvalFlow(name, finished, opts), opts.queueName);
  const mcp = await connectMcp(port, {
    BUNQUEUE_MCP_WORKFLOW_DB: dbPath,
    ...(opts.queueName ? { BUNQUEUE_MCP_WORKFLOW_QUEUE: opts.queueName } : {}),
    ...opts.env,
  });
  return { dir, port, dbPath, engine, mcp, name, finished };
}

async function startParked(engine: Engine, name: string, input: unknown = { orderId: 'o-1' }) {
  const run = await engine.start(name, input);
  expect((await waitForWorkflowState(engine, run.id, 'waiting', 10_000))?.state).toBe('waiting');
  return run.id;
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

async function settled(engine: Engine, id: string): Promise<Execution> {
  const deadline = Date.now() + 10_000;
  let exec = engine.getExecution(id);
  while (exec?.state !== 'completed' && exec?.state !== 'failed' && Date.now() < deadline) {
    await Bun.sleep(10);
    exec = engine.getExecution(id);
  }
  return exec as Execution;
}

describe('workflow tools against a TCP Engine', () => {
  test('lists, inspects and signals a parked run; the Engine finishes it with the payload', async () => {
    const { engine, mcp, name, finished } = await setup();
    const id = await startParked(engine, name);
    expect(await mcp.toolNames()).toEqual(expect.arrayContaining(WORKFLOW_TOOLS));

    const listed = await mcp.call('bunqueue_list_workflow_executions', {
      workflowName: name,
      state: 'waiting',
    });
    expect(listed.isError).toBe(false);
    expect(listed.json).toMatchObject({ count: 1, limit: 50, offset: 0, nextOffset: null });
    expect(listed.json.executions[0]).toMatchObject({
      id,
      workflowName: name,
      state: 'waiting',
      currentNodeIndex: 1,
      waitingFor: null,
      signalEvents: [],
    });
    const page = await mcp.call('bunqueue_list_workflow_executions', { limit: 1 });
    expect(page.json).toMatchObject({ count: 1, nextOffset: 1 });
    expect((await mcp.call('bunqueue_list_workflow_executions', { offset: 1 })).json.count).toBe(0);

    const got = await mcp.call(GET, { executionId: id });
    expect(got.json).toMatchObject({
      id,
      state: 'waiting',
      input: { orderId: 'o-1' },
      signals: [],
    });
    expect(got.json.steps).toContainEqual(
      expect.objectContaining({ name: 'prepare', status: 'completed', result: { prepared: true } })
    );

    const payload = { approved: true, by: 'alice' };
    const sent = await mcp.call(SIGNAL, { executionId: id, event: 'approval', payload });
    expect(sent.isError).toBe(false);
    expect(sent.json).toMatchObject({ recorded: true, resumed: true, nodeIndex: 1 });
    expect(sent.json.queue).toBe('__wf:steps');

    const done = await waitForWorkflowState(engine, id, 'completed', 10_000);
    expect(done?.state).toBe('completed');
    expect(finished.get(id)).toEqual([payload]);
    expect(done?.steps.finish?.result).toEqual({ approval: payload });
    // Like the Engine's own step jobs, the resume job is not retained once it completes.
    let retained = true;
    for (let i = 0; i < 50 && retained; i++) {
      retained = !(await mcp.call('bunqueue_get_job', { jobId: sent.json.jobId })).isError;
      if (retained) await Bun.sleep(20);
    }
    expect(retained).toBe(false);
    const after = await mcp.call(GET, { executionId: id });
    expect(after.json).toMatchObject({
      state: 'completed',
      signals: [{ event: 'approval', payload }],
    });
  });

  test('BUNQUEUE_MCP_CONFIRM gates the signal on its execution id; a custom step queue is used', async () => {
    const queueName = `wf-steps-${crypto.randomUUID()}`;
    const { engine, mcp, name, finished } = await setup({
      queueName,
      env: { BUNQUEUE_MCP_CONFIRM: 'destructive' },
    });
    const id = await startParked(engine, name);

    const tools = (await mcp.client.listTools()).tools;
    expect(tools.find((t) => t.name === SIGNAL)?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tools.find((t) => t.name === GET)?.annotations?.readOnlyHint).toBe(true);
    expect((await mcp.call(GET, { executionId: id })).isError).toBe(false);

    const args = { executionId: id, event: 'approval', payload: { approved: true } };
    const blocked = await mcp.call(SIGNAL, args);
    expect(blocked.isError).toBe(true);
    expect(blocked.json.executed).toBe(false);
    for (const part of [name, id, '"approval"', '{"approved":true}', 'cannot be undone']) {
      expect(String(blocked.json.impact)).toContain(part);
    }
    expect((await mcp.call(SIGNAL, { ...args, confirm: 'another-id' })).isError).toBe(true);
    expect(engine.getExecution(id)).toMatchObject({ state: 'waiting', signals: {} });

    const confirmed = await mcp.call(SIGNAL, { ...args, confirm: id });
    expect(confirmed.isError).toBe(false);
    expect(confirmed.json).toMatchObject({ recorded: true, resumed: true, queue: queueName });
    expect((await waitForWorkflowState(engine, id, 'completed', 10_000))?.state).toBe('completed');
    expect(finished.get(id)).toEqual([{ approved: true }]);
  });

  test('rejects unknown ids, unusable or mismatched events, duplicates and finished runs', async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { engine, mcp, name, finished } = await setup({ timeout: 60_000, hold });
    const id = await startParked(engine, name);
    // A gate with a timeout records which event it waits for.
    expect((await mcp.call(GET, { executionId: id })).json.waitingFor).toBe('approval');

    const unknown = await mcp.call(SIGNAL, { executionId: 'nope', event: 'approval' });
    expect(unknown).toMatchObject({
      isError: true,
      json: { error: expect.stringMatching(/not found/) },
    });
    expect((await mcp.call(GET, { executionId: 'nope' })).isError).toBe(true);
    const proto = await mcp.call(SIGNAL, { executionId: id, event: '__proto__' });
    expect(proto.json.error).toMatch(/__proto__/);
    const typo = await mcp.call(SIGNAL, { executionId: id, event: 'aproval', payload: true });
    expect(typo.json.error).toMatch(/waiting for the event "approval", not "aproval"/);
    expect(engine.getExecution(id)?.signals).toEqual({});

    // No payload: recorded as present-but-undefined, exactly like engine.signal(id, event).
    expect((await mcp.call(SIGNAL, { executionId: id, event: 'approval' })).json).toMatchObject({
      recorded: true,
      resumed: true,
    });
    // The step after the gate is running (held open): the run is live, the signal is in.
    await until(() => finished.has(id));
    const dup = await mcp.call(SIGNAL, { executionId: id, event: 'approval', payload: false });
    expect(dup.json.error).toMatch(/already received/);
    release();
    const done = await waitForWorkflowState(engine, id, 'completed', 10_000);
    expect(Object.hasOwn(done?.signals ?? {}, 'approval')).toBe(true);
    expect((await mcp.call(GET, { executionId: id })).json.signals).toEqual([
      { event: 'approval', payload: null },
    ]);
    const late = await mcp.call(SIGNAL, { executionId: id, event: 'other' });
    expect(late.json.error).toMatch(/"completed" and cannot receive/);
  });

  test('a signal racing the waitFor timeout either resumes the run or is refused, never both', async () => {
    const TIMEOUT = 300;
    const { engine, mcp, name, finished } = await setup({ timeout: TIMEOUT });
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, i) => startParked(engine, name, { i }))
    );
    const replies = await Promise.all(
      ids.map(async (id, i) => {
        const parkedAt = engine.getExecution(id)?.steps['__waitFor:approval']?.startedAt ?? 0;
        // Spread the deliveries from 100 ms before to 100 ms after the deadline.
        await Bun.sleep(Math.max(0, parkedAt + TIMEOUT - 100 + i * 40 - Date.now()));
        return mcp.call(SIGNAL, { executionId: id, event: 'approval', payload: { i } });
      })
    );
    for (const [i, id] of ids.entries()) {
      const final = await settled(engine, id);
      if (final.state === 'completed') {
        expect(replies[i].isError).toBe(false);
        expect(final.failureReason).toBeUndefined();
        expect(finished.get(id)).toEqual([{ i }]);
      } else {
        expect(final.state).toBe('failed');
        expect(final.failureReason).toMatch(/timed out/);
        expect(replies[i].json.error).toMatch(/and cannot receive the signal "approval"/);
      }
    }
    await Bun.sleep(200);
    for (const id of ids) {
      if (engine.getExecution(id)?.state === 'failed') expect(finished.has(id)).toBe(false);
    }
  });

  test('a failed resume enqueue restores the wait with the signal kept; recover() resumes it', async () => {
    const dir = tempDir();
    const port = startBroker(dir);
    const dbPath = join(dir, 'workflow.db');
    const name = `approval-${crypto.randomUUID()}`;
    const finished = new Map<string, unknown[]>();
    const engine = startEngine(port, dbPath, approvalFlow(name, finished));
    const failingAdd: Wrap = (backend) =>
      new Proxy(backend, {
        get(target, prop) {
          if (prop === 'addJob') return () => Promise.reject(new Error('broker unavailable'));
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    const mcp = await connectMcp(port, { BUNQUEUE_MCP_WORKFLOW_DB: dbPath }, failingAdd);
    const id = await startParked(engine, name);

    const reply = await mcp.call(SIGNAL, { executionId: id, event: 'approval', payload: 'go' });
    expect(reply.isError).toBe(true);
    expect(reply.json).toMatchObject({ recorded: true, resumed: false, restored: true });
    expect(reply.json.error).toMatch(/broker unavailable/);
    expect(engine.getExecution(id)).toMatchObject({
      state: 'waiting',
      signals: { approval: 'go' },
    });
    const again = await mcp.call(SIGNAL, { executionId: id, event: 'approval', payload: 'go' });
    expect(again.json.error).toMatch(/already received/);

    await engine.recover();
    expect((await waitForWorkflowState(engine, id, 'completed', 10_000))?.state).toBe('completed');
    expect(finished.get(id)).toEqual(['go']);
  });

  test('get_workflow_execution turns structured-clone values into plain JSON', async () => {
    const { engine, mcp, name } = await setup();
    const id = await startParked(engine, name, {
      big: 2n ** 60n,
      when: new Date(0),
      map: new Map([['k', 1]]),
      set: new Set(['a']),
      bytes: new Uint8Array([1, 2, 3]),
      err: new Error('boom'),
      gone: undefined,
    });
    expect((await mcp.call(GET, { executionId: id })).json.input).toEqual({
      big: '1152921504606846976',
      when: '1970-01-01T00:00:00.000Z',
      map: { $type: 'Map', entries: [['k', 1]] },
      set: { $type: 'Set', values: ['a'] },
      bytes: { $type: 'bytes', byteLength: 3, base64: 'AQID' },
      err: { $type: 'Error', name: 'Error', message: 'boom' },
    });
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(toJsonSafe(cyclic)).toEqual({ a: 1, self: '[Circular]' });
  });
});

describe('workflow tools configuration and topology', () => {
  function setupWith(env: Record<string, string>) {
    shutdownManager();
    const backend = new EmbeddedBackend();
    const handlers = new HttpHandlerRegistry();
    try {
      return setupTools(new McpServer({ name: 't', version: '0' }), backend, handlers, { env });
    } finally {
      handlers.shutdown();
      backend.shutdown();
    }
  }

  test('without BUNQUEUE_MCP_WORKFLOW_DB no workflow tool is registered', async () => {
    const mcp = await startMcp();
    cleanups.push(mcp.close);
    const alwaysOn = Object.entries(TOOL_POLICIES)
      .filter(([, policy]) => !policy.optional)
      .map(([tool]) => tool)
      .sort();
    expect(await mcp.toolNames()).toEqual(alwaysOn);
    expect([...setupWith({}).keys()].filter((tool) => tool.includes('workflow'))).toEqual([]);
  });

  test('a missing, foreign or unreadable database is a startup error and is never created', () => {
    const dir = tempDir();
    const missing = join(dir, 'missing.db');
    expect(() => setupWith({ BUNQUEUE_MCP_WORKFLOW_DB: missing })).toThrow(/does not exist/);
    expect(existsSync(missing)).toBe(false);
    expect(() => setupWith({ BUNQUEUE_MCP_WORKFLOW_DB: dir })).toThrow(/not a file/);
    const foreign = join(dir, 'foreign.db');
    const db = new Database(foreign);
    db.run('CREATE TABLE other (x INTEGER)');
    db.close();
    expect(() => setupWith({ BUNQUEUE_MCP_WORKFLOW_DB: foreign })).toThrow(
      /not a bunqueue workflow database/
    );
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'not sqlite '.repeat(50));
    expect(() => setupWith({ BUNQUEUE_MCP_WORKFLOW_DB: junk })).toThrow(/cannot be opened/);
  });

  test('an embedded MCP server can read runs but is not offered the signal tool', async () => {
    const dbPath = join(tempDir(), 'workflow.db');
    new WorkflowStore(dbPath).close();
    const mcp = await startMcp({ env: { BUNQUEUE_MCP_WORKFLOW_DB: dbPath } });
    cleanups.push(mcp.close);
    const names = await mcp.toolNames();
    expect(names.filter((tool) => tool.includes('workflow'))).toEqual(WORKFLOW_TOOLS.slice(0, 2));
    expect((await mcp.call('bunqueue_list_workflow_executions')).json.count).toBe(0);
  });

  test('the database of an embedded Engine is not offered the signal tool', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'app.db');
    shutdownManager();
    const embedded = new Engine({ embedded: true, dataPath: dbPath });
    await embedded.close(true);
    shutdownManager();
    const mcp = await connectMcp(startBroker(dir), { BUNQUEUE_MCP_WORKFLOW_DB: dbPath });
    expect((await mcp.toolNames()).filter((tool) => tool.includes('workflow'))).toEqual(
      WORKFLOW_TOOLS.slice(0, 2)
    );
  });

  test('the workflows toolset needs the database; with it, it lists exactly its tools', async () => {
    expect(() => setupWith({ BUNQUEUE_MCP_TOOLSETS: 'workflows' })).toThrow(/workflows/);
    const dir = tempDir();
    const dbPath = join(dir, 'workflow.db');
    new WorkflowStore(dbPath).close();
    const only = await connectMcp(startBroker(dir), {
      BUNQUEUE_MCP_WORKFLOW_DB: dbPath,
      BUNQUEUE_MCP_TOOLSETS: 'workflows',
    });
    expect(await only.toolNames()).toEqual(WORKFLOW_TOOLS);

    const dynamic = await startMcp({ env: { BUNQUEUE_MCP_TOOLSETS: 'dynamic' } });
    cleanups.push(dynamic.close);
    const catalog = (await dynamic.client.listTools()).tools.find(
      (t) => t.name === 'bunqueue_enable_toolsets'
    );
    expect(catalog?.description).toContain('- jobs:');
    expect(catalog?.description).not.toContain('- workflows:');
  });
});
