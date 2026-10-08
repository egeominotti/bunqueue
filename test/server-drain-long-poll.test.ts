/**
 * A pull that finds nothing during the shutdown drain must not answer at once.
 *
 * The drain stops handing out jobs. If every PULL/PULLB then returned empty
 * immediately, an SDK Worker using a long poll (it re-polls 10 ms after an empty
 * answer) would hammer the stopping broker about 100 times a second per worker for
 * the whole drain. During the drain a pull with a timeout therefore claims nothing
 * and holds until its own timeout or until its connection ends; a pull without a
 * timeout returns empty at once, as for an empty queue.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { Worker } from '../src/client';
import { TcpClient } from '../src/client/tcp/client';
import type { JobId } from '../src/domain/types/job';
import { handleCommand } from '../src/infrastructure/server/handler';
import { createHttpServer } from '../src/infrastructure/server/http';
import { createTcpServer, type TcpServer } from '../src/infrastructure/server/tcp';

const QUEUE = 'drain-long-poll';
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // already closed by the test
    }
  }
});

function setup(): { qm: QueueManager; server: TcpServer; pulls: () => number } {
  const qm = new QueueManager();
  cleanups.push(() => qm.shutdown());
  let pulls = 0;
  const target = qm as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ['pull', 'pullWithLock', 'pullBatch', 'pullBatchWithLock']) {
    const original = target[method].bind(qm);
    target[method] = (...args: unknown[]) => {
      pulls++;
      return original(...args);
    };
  }
  const server = createTcpServer(qm, { hostname: '127.0.0.1', port: 0 });
  cleanups.push(() => server.stop());
  return { qm, server, pulls: () => pulls };
}

async function client(port: number): Promise<TcpClient> {
  const tcp = new TcpClient({
    host: '127.0.0.1',
    port,
    autoReconnect: false,
    pingInterval: 0,
    commandTimeout: 30_000,
  });
  await tcp.connect();
  cleanups.push(() => tcp.close());
  // A round trip proves the broker has opened the connection before the drain begins.
  expect((await tcp.send({ cmd: 'Ping' })).ok).toBe(true);
  return tcp;
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await Bun.sleep(10);
  }
}

describe('pulls during the shutdown drain', () => {
  test('a long-polling SDK Worker re-polls once per poll timeout, not in a hot loop', async () => {
    const { qm, server, pulls } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const processed: string[] = [];
    const held = await qm.push(QUEUE, { data: { hold: true } });
    const worker = new Worker(
      QUEUE,
      async (job) => {
        processed.push(String(job.id));
        if ((job.data as { hold?: boolean }).hold) await gate;
        return 'done';
      },
      {
        embedded: false,
        connection: { host: '127.0.0.1', port: server.server.port },
        concurrency: 2,
        pollTimeout: 1_000,
        heartbeatInterval: 0,
      }
    );
    cleanups.push(() => worker.close(true));
    await waitFor(async () => (await qm.getJobState(held.id)) === 'active');

    server.beginDrain();
    const before = pulls();
    const late = await qm.push(QUEUE, { data: { late: true } });
    await Bun.sleep(2_000);
    const during = pulls() - before;

    // About one pull per second of drain (pollTimeout 1000 ms); a hot loop makes ~200.
    expect(during).toBeLessThanOrEqual(5);
    expect(processed).toEqual([String(held.id)]);
    expect(await qm.getJobState(late.id)).toBe('waiting');

    release();
    await waitFor(async () => (await qm.getJobState(held.id)) === 'completed');
    expect(await qm.getJobState(late.id)).toBe('waiting');
  }, 15_000);

  test('a TCP pull holds until its own timeout, delivers nothing, and timeout 0 answers at once', async () => {
    const { qm, server } = setup();
    const tcp = await client(server.server.port);
    server.beginDrain();

    let startedAt = Date.now();
    expect((await tcp.send({ cmd: 'PULL', queue: QUEUE })).job).toBeNull();
    expect((await tcp.send({ cmd: 'PULLB', queue: QUEUE, count: 3 })).jobs).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(500);

    startedAt = Date.now();
    const parked = tcp.send({ cmd: 'PULLB', queue: QUEUE, count: 3, timeout: 600, owner: 'w' });
    await Bun.sleep(100);
    const late = await qm.push(QUEUE, { data: {} });
    expect((await parked).jobs).toEqual([]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(550);
    expect(await qm.getJobState(late.id as JobId)).toBe('waiting');
  });

  test('a pull parked before the drain stops claiming but keeps holding', async () => {
    const { qm, server } = setup();
    const tcp = await client(server.server.port);
    const startedAt = Date.now();
    const parked = tcp.send({ cmd: 'PULL', queue: QUEUE, timeout: 700 });
    await Bun.sleep(100);

    server.beginDrain();
    const late = await qm.push(QUEUE, { data: {} });
    expect((await parked).job).toBeNull();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(650);
    expect(await qm.getJobState(late.id)).toBe('waiting');
  });

  test('stop() ends a held TCP pull at once', async () => {
    const { server } = setup();
    const tcp = await client(server.server.port);
    server.beginDrain();
    const parked = tcp.send({ cmd: 'PULL', queue: QUEUE, timeout: 20_000 });
    await Bun.sleep(100);

    const stoppedAt = Date.now();
    server.stop();
    await parked.then(
      () => undefined,
      () => undefined
    );
    expect(Date.now() - stoppedAt).toBeLessThan(1_000);
  });

  test('the client connection ending releases a held pull at once (handler level)', async () => {
    const qm = new QueueManager();
    cleanups.push(() => qm.shutdown());
    const drain = new AbortController();
    const connection = new AbortController();
    drain.abort();
    const ctx = {
      queueManager: qm,
      authTokens: new Set<string>(),
      authenticated: true,
      signal: AbortSignal.any([connection.signal, drain.signal]),
      drainSignal: drain.signal,
      connectionSignal: connection.signal,
    };
    const startedAt = Date.now();
    const parked = handleCommand({ cmd: 'PULL', queue: QUEUE, timeout: 20_000 }, ctx);
    await Bun.sleep(100);
    connection.abort();
    expect(((await parked) as { job: unknown }).job).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test('HTTP over a Unix socket: a held long poll delivers nothing and stop() ends it', async () => {
    const qm = new QueueManager();
    cleanups.push(() => qm.shutdown());
    const dir = mkdtempSync(join(tmpdir(), 'bq-drain-long-poll-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, 'http.sock');
    const http = createHttpServer(qm, { socketPath });
    cleanups.push(() => http.stop());

    const parked = fetch(`http://localhost/queues/${QUEUE}/jobs?timeout=20000`, {
      unix: socketPath,
    });
    await Bun.sleep(100);
    http.beginDrain();
    await qm.push(QUEUE, { data: {} });
    await Bun.sleep(300);

    const stoppedAt = Date.now();
    http.stop();
    expect(((await (await parked).json()) as { job: unknown }).job).toBeNull();
    expect(Date.now() - stoppedAt).toBeLessThan(1_000);
  });

  test('WebSocket: a pull during the drain holds until its timeout', async () => {
    const qm = new QueueManager();
    cleanups.push(() => qm.shutdown());
    const http = createHttpServer(qm, { hostname: '127.0.0.1', port: 0 });
    cleanups.push(() => http.stop());
    const ws = new WebSocket(`ws://127.0.0.1:${http.server.port}/ws`);
    cleanups.push(() => ws.close());
    const replies = new Map<string, (value: Record<string, unknown>) => void>();
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (typeof message.reqId === 'string') replies.get(message.reqId)?.(message);
    };
    await new Promise((resolve) => (ws.onopen = resolve));
    const send = (reqId: string, command: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        replies.set(reqId, resolve);
        ws.send(JSON.stringify({ ...command, reqId }));
      });

    http.beginDrain();
    const startedAt = Date.now();
    const parked = send('held', { cmd: 'PULL', queue: QUEUE, timeout: 500 });
    await Bun.sleep(100);
    const late = await qm.push(QUEUE, { data: {} });
    expect((await parked).job).toBeNull();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
    expect(await qm.getJobState(late.id)).toBe('waiting');
  });
});
