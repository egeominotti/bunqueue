/**
 * The shutdown drain must stop new work without cutting off the work in flight: once
 * `beginDrain()` runs, the listeners refuse new connections and every pull (parked or
 * new) delivers nothing (a pull with a timeout holds empty until it expires, see
 * test/server-drain-long-poll.test.ts), while the open connections keep serving ACK, FAIL, heartbeats
 * and progress so workers can finish the jobs they hold. Covered for plain TCP, TCP
 * over TLS, WebSocket, and HTTP over a Unix socket.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { TcpClient } from '../src/client/tcp/client';
import type { JobId } from '../src/domain/types/job';
import { createHttpServer, type HttpServer } from '../src/infrastructure/server/http';
import { createTcpServer, type TcpServer } from '../src/infrastructure/server/tcp';

const QUEUE = 'drain-intake';

const cleanups: Array<() => void> = [];
let dir = '';

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch {
      // already stopped by the test
    }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function tempDir(): string {
  dir ||= mkdtempSync(join(tmpdir(), 'bq-drain-intake-'));
  return dir;
}

function manager(): QueueManager {
  const qm = new QueueManager();
  cleanups.push(() => qm.shutdown());
  return qm;
}

function tcpServer(qm: QueueManager, tls?: { certFile: string; keyFile: string }): TcpServer {
  const server = createTcpServer(qm, { hostname: '127.0.0.1', port: 0, ...(tls && { tls }) });
  cleanups.push(() => server.stop());
  return server;
}

async function client(port: number, tls?: boolean): Promise<TcpClient> {
  const tcp = new TcpClient({
    host: '127.0.0.1',
    port,
    autoReconnect: false,
    pingInterval: 0,
    commandTimeout: 5_000,
    connectTimeout: 5_000,
    ...(tls && { tls: { rejectUnauthorized: false } }),
  });
  await tcp.connect();
  cleanups.push(() => tcp.close());
  return tcp;
}

function certificate(): { certFile: string; keyFile: string } {
  const certFile = join(tempDir(), 'cert.pem');
  const keyFile = join(tempDir(), 'key.pem');
  const generated = Bun.spawnSync([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyFile,
    '-out',
    certFile,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
  return { certFile, keyFile };
}

/** Pull one job under a lease and push one more that stays waiting. */
async function holdOneJob(tcp: TcpClient) {
  const held = String((await tcp.send({ cmd: 'PUSH', queue: QUEUE, data: { n: 1 } })).id);
  const pulled = await tcp.send({ cmd: 'PULL', queue: QUEUE, owner: 'w', lockTtl: 60_000 });
  expect((pulled.job as { id: string }).id).toBe(held);
  const waiting = String((await tcp.send({ cmd: 'PUSH', queue: QUEUE, data: { n: 2 } })).id);
  return { held, token: pulled.token as string, waiting };
}

async function expectDrainedTcp(server: TcpServer, qm: QueueManager, tls?: boolean) {
  const port = server.server.port;
  const tcp = await client(port, tls);
  const { held, token, waiting } = await holdOneJob(tcp);
  const parkedAt = Date.now();
  const parked = tcp.send({ cmd: 'PULL', queue: 'idle', timeout: 600 });
  await Bun.sleep(50);

  server.beginDrain();
  await qm.push('idle', { data: {} });
  expect((await parked).job).toBeNull();
  expect(Date.now() - parkedAt).toBeGreaterThanOrEqual(550);

  expect((await tcp.send({ cmd: 'PULL', queue: QUEUE, owner: 'w' })).job).toBeNull();
  expect((await tcp.send({ cmd: 'PULLB', queue: QUEUE, count: 5 })).jobs).toEqual([]);
  expect(await qm.getJobState(waiting as JobId)).toBe('waiting');

  expect((await tcp.send({ cmd: 'JobHeartbeat', id: held, token })).ok).toBe(true);
  expect((await tcp.send({ cmd: 'Progress', id: held, progress: 50 })).ok).toBe(true);
  expect((await tcp.send({ cmd: 'ACK', id: held, token, result: { ok: 1 } })).ok).toBe(true);
  expect(await qm.getJobState(held as JobId)).toBe('completed');

  await expect(client(port, tls)).rejects.toThrow();
}

describe('server shutdown intake', () => {
  test('TCP: drain refuses new work and keeps the lifecycle of held jobs', async () => {
    const qm = manager();
    await expectDrainedTcp(tcpServer(qm), qm);
  });

  test('TCP over TLS: drain refuses new work and keeps the lifecycle of held jobs', async () => {
    const qm = manager();
    await expectDrainedTcp(tcpServer(qm, certificate()), qm, true);
  });

  test('TCP: a job still held when a drained server stops is abandoned, not released', async () => {
    const qm = manager();
    const server = tcpServer(qm);
    const { held } = await holdOneJob(await client(server.server.port));

    server.beginDrain();
    server.stop();
    await Bun.sleep(100);

    expect(await qm.getJobState(held as JobId)).toBe('active');
  });

  test('TCP: stopping a server that never drained still releases held jobs', async () => {
    const qm = manager();
    const server = tcpServer(qm);
    const { held } = await holdOneJob(await client(server.server.port));

    server.stop();
    await Bun.sleep(100);

    expect(await qm.getJobState(held as JobId)).toBe('waiting');
  });

  test('WebSocket: drain refuses pulls and keeps ACK on the open socket', async () => {
    const qm = manager();
    const http = createHttpServer(qm, { hostname: '127.0.0.1', port: 0 });
    cleanups.push(() => http.stop());
    const port = http.server.port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    cleanups.push(() => ws.close());
    const replies = new Map<string, (value: Record<string, unknown>) => void>();
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      const reqId = message.reqId as string | undefined;
      if (reqId) replies.get(reqId)?.(message);
    };
    await new Promise((resolve) => (ws.onopen = resolve));
    let seq = 0;
    const send = (command: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const reqId = `r${++seq}`;
        replies.set(reqId, resolve);
        ws.send(JSON.stringify({ ...command, reqId }));
      });

    const held = String((await send({ cmd: 'PUSH', queue: QUEUE, data: {} })).id);
    const pulled = await send({ cmd: 'PULL', queue: QUEUE, owner: 'w', lockTtl: 60_000 });
    expect((pulled.job as { id: string }).id).toBe(held);
    await send({ cmd: 'PUSH', queue: QUEUE, data: {} });

    http.beginDrain();
    expect((await send({ cmd: 'PULL', queue: QUEUE, owner: 'w' })).job).toBeNull();
    expect((await send({ cmd: 'ACK', id: held, token: pulled.token })).ok).toBe(true);
    expect(await qm.getJobState(held as JobId)).toBe('completed');
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  test('HTTP over a Unix socket: a parked long poll holds empty and new requests are refused', async () => {
    const qm = manager();
    const socketPath = join(tempDir(), 'http.sock');
    const http = createHttpServer(qm, { socketPath });
    cleanups.push(() => http.stop());
    const get = (path: string) => fetch(`http://localhost${path}`, { unix: socketPath });

    expect((await get('/health')).status).toBe(200);
    const parkedAt = Date.now();
    const parked = get('/queues/idle/jobs?timeout=600');
    await Bun.sleep(50);

    http.beginDrain();
    // A job arriving now must not be handed to the parked poll.
    await qm.push('idle', { data: {} });
    await expect(get('/health')).rejects.toThrow();
    expect(((await (await parked).json()) as { job: unknown }).job).toBeNull();
    expect(Date.now() - parkedAt).toBeGreaterThanOrEqual(550);
  });
});
