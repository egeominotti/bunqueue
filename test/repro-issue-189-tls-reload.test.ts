/**
 * REPRO — issue #189, in process: `reloadServerTls` swaps the certificate of running
 * TCP and HTTP listeners without dropping connections.
 *
 * Run: bun test test/repro-issue-189-tls-reload.test.ts
 *
 * Bun ignores `reload({ tls })` on both listener types, so a reload replaces the
 * listener: a new one binds the same port (SO_REUSEPORT) with the new pair, then the
 * old one stops accepting while its open sockets stay served. Contract pinned here:
 * - after a reload, new handshakes on TCP, HTTP and an HTTP unix socket get the new
 *   certificate; a TCP connection and a WebSocket opened before keep working;
 * - the reload is all-or-nothing across listeners: when one cannot take the new pair,
 *   the listeners already prepared are rolled back and every port keeps the old one
 *   (`outcome: 'kept-previous'`; a failing rollback or commit is `'degraded'`, see
 *   `repro-issue-189-tls-reload-outcomes.test.ts`);
 * - a bad pair (mismatch, unreadable, garbage) is refused before anything changes;
 * - the HTTP unix socket keeps the mode an operator gave it across a reload;
 * - repeated reloads leak no listener: `stop()` also ends the connections a retired
 *   listener accepted, the port is free again afterwards, and a second server can
 *   never bind a port a TLS server is listening on;
 * - a server that began its shutdown drain never rebinds (`outcome: 'shutting-down'`).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { createHttpServer, type HttpServer } from '../src/infrastructure/server/http';
import { createTcpServer, type TcpServer } from '../src/infrastructure/server/tcp';
import { reloadServerTls } from '../src/infrastructure/server/tlsReload';
import {
  installPair,
  makeCertSet,
  PingConnection,
  servedFingerprint,
  type CertSet,
} from './tls-reload-support';

let qm: QueueManager;
let set: CertSet;
const stops: Array<() => void> = [];

beforeAll(() => {
  qm = new QueueManager();
});

afterAll(() => {
  qm.shutdown();
});

afterEach(() => {
  for (const stop of stops.splice(0).reverse()) {
    try {
      stop();
    } catch {
      // already stopped by the test
    }
  }
  set?.cleanup();
});

function tls() {
  return { certFile: set.live.cert, keyFile: set.live.key };
}

function tcpServer(port = 0): TcpServer {
  const server = createTcpServer(qm, { hostname: '127.0.0.1', port, tls: tls() });
  stops.push(() => server.stop());
  return server;
}

function httpServer(options: { socketPath?: string } = {}): HttpServer {
  const server = createHttpServer(qm, {
    hostname: '127.0.0.1',
    port: 0,
    ...(options.socketPath && { socketPath: options.socketPath }),
    tls: tls(),
  });
  stops.push(() => server.stop());
  return server;
}

function canBindExclusively(port: number): boolean {
  try {
    Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
}

async function openWebSocket(port: number): Promise<{ ws: WebSocket; replies: string[] }> {
  const replies: string[] = [];
  // The test tree's WebSocket type is the DOM one, which lacks Bun's options overload.
  const options: Bun.WebSocketOptions = { tls: { rejectUnauthorized: false } };
  const ws: WebSocket = Reflect.construct(WebSocket, [`wss://127.0.0.1:${port}/ws`, options]);
  ws.onmessage = (event) => replies.push(String(event.data));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WebSocket failed to open'));
  });
  return { ws, replies };
}

async function wsPing(socket: { ws: WebSocket; replies: string[] }): Promise<boolean> {
  const before = socket.replies.length;
  socket.ws.send(JSON.stringify({ cmd: 'Ping', reqId: 'ws-tls-reload' }));
  const startedAt = Date.now();
  while (socket.replies.length === before && Date.now() - startedAt < 3_000) await Bun.sleep(10);
  return socket.replies.length > before && socket.ws.readyState === WebSocket.OPEN;
}

describe('issue #189: reloadServerTls', () => {
  test('TCP and HTTP serve the new certificate; open TCP and WebSocket connections stay', async () => {
    set = makeCertSet();
    const tcp = tcpServer();
    const http = httpServer();
    const tcpPort = tcp.server.port;
    const httpPort = http.server.port as number;
    expect(await servedFingerprint(tcpPort)).toBe(set.a.fingerprint);
    expect(await servedFingerprint(httpPort)).toBe(set.a.fingerprint);

    const conn = await PingConnection.open(tcpPort);
    stops.push(() => conn.close());
    const ws = await openWebSocket(httpPort);
    stops.push(() => ws.ws.close());
    expect((await conn.ping())?.ok).toBe(true);
    expect(await wsPing(ws)).toBe(true);

    installPair(set, set.b.cert, set.b.key);
    const result = reloadServerTls([tcp, http], tls());
    expect(result).toEqual({
      ok: true,
      certificate: {
        subject: 'CN=localhost-b',
        notAfter: set.b.notAfter,
        fingerprint256: set.b.fingerprint,
      },
    });
    Bun.gc(true);

    for (let i = 0; i < 8; i++) {
      expect(await servedFingerprint(tcpPort)).toBe(set.b.fingerprint);
      expect(await servedFingerprint(httpPort)).toBe(set.b.fingerprint);
    }
    // Same port numbers, same connections.
    expect(tcp.server.port).toBe(tcpPort);
    expect(http.server.port).toBe(httpPort);
    expect((await conn.ping())?.ok).toBe(true);
    expect(conn.closed).toBe(false);
    expect(await wsPing(ws)).toBe(true);
    expect(tcp.getConnectionCount()).toBeGreaterThanOrEqual(1);
  });

  test('all-or-nothing: a listener that cannot take the pair rolls the others back', async () => {
    set = makeCertSet();
    const tcp = tcpServer();
    const tcpPort = tcp.server.port;
    installPair(set, set.b.cert, set.b.key);

    const events: string[] = [];
    const spy = {
      prepareTlsReload() {
        events.push('spy:prepare');
        return {
          commit: () => events.push('spy:commit'),
          abort: () => events.push('spy:abort'),
        };
      },
    };
    const failing = {
      prepareTlsReload(): never {
        events.push('failing:prepare');
        throw new Error('bind refused');
      },
    };
    const result = reloadServerTls([spy, tcp, failing], tls());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('bind refused');
      expect(result.outcome).toBe('kept-previous');
    }
    expect(events).toEqual(['spy:prepare', 'failing:prepare', 'spy:abort']);
    for (let i = 0; i < 8; i++) expect(await servedFingerprint(tcpPort)).toBe(set.a.fingerprint);

    // The rolled-back listener can still reload later.
    expect(reloadServerTls([tcp], tls()).ok).toBe(true);
    expect(await servedFingerprint(tcpPort)).toBe(set.b.fingerprint);
  });

  test('a pair that cannot be loaded is refused before anything changes', async () => {
    set = makeCertSet();
    const tcp = tcpServer();
    const http = httpServer();
    const ports = [tcp.server.port, http.server.port as number];
    const garbage = join(set.dir, 'garbage.pem');
    writeFileSync(garbage, 'not a pem');
    const bad: Array<[string, () => void]> = [
      ['mismatch', () => installPair(set, set.b.cert, set.a.key)],
      ['garbage cert', () => installPair(set, garbage, set.b.key)],
      ['garbage key', () => installPair(set, set.b.cert, garbage)],
      ['missing cert', () => rmSync(set.live.cert)],
    ];
    for (const [label, apply] of bad) {
      installPair(set, set.a.cert, set.a.key);
      apply();
      const result = reloadServerTls([tcp, http], tls());
      expect({ label, ok: result.ok }).toEqual({ label, ok: false });
      if (!result.ok)
        expect({ label, outcome: result.outcome }).toEqual({ label, outcome: 'kept-previous' });
      for (const port of ports) expect(await servedFingerprint(port)).toBe(set.a.fingerprint);
    }
  });

  test('the HTTP unix-socket listener reloads too', async () => {
    set = makeCertSet();
    const socketDir = mkdtempSync(join(tmpdir(), 'bq-tls-reload-sock-'));
    stops.push(() => rmSync(socketDir, { recursive: true, force: true }));
    const socketPath = join(socketDir, 'http.sock');
    const http = httpServer({ socketPath });
    expect(await servedFingerprint(socketPath)).toBe(set.a.fingerprint);
    // Access an operator granted after startup survives the rebind of the path.
    chmodSync(socketPath, 0o660);

    installPair(set, set.b.cert, set.b.key);
    expect(reloadServerTls([http], tls()).ok).toBe(true);
    for (let i = 0; i < 4; i++) expect(await servedFingerprint(socketPath)).toBe(set.b.fingerprint);
    expect(statSync(socketPath).mode & 0o777).toBe(0o660);
  });

  test('repeated reloads leak no listener and keep the port exclusive', async () => {
    set = makeCertSet();
    const tcp = tcpServer();
    const port = tcp.server.port;
    const conn = await PingConnection.open(port);
    stops.push(() => conn.close());

    for (let i = 0; i < 20; i++) {
      const pair = i % 2 === 0 ? set.b : set.a;
      installPair(set, pair.cert, pair.key);
      expect(reloadServerTls([tcp], tls()).ok).toBe(true);
      expect(await servedFingerprint(port)).toBe(pair.fingerprint);
      // No other server can join the port, before or after a reload.
      expect(canBindExclusively(port)).toBe(false);
      expect(() => createTcpServer(qm, { hostname: '127.0.0.1', port, tls: tls() })).toThrow();
    }
    expect((await conn.ping())?.ok).toBe(true);

    // `stop()` ends the connection the first (long retired) listener accepted.
    tcp.stop();
    const startedAt = Date.now();
    while (!conn.closed && Date.now() - startedAt < 3_000) await Bun.sleep(10);
    expect(conn.closed).toBe(true);
    await Bun.sleep(50);
    expect(canBindExclusively(port)).toBe(true);
  });

  test('a TLS server refuses a port another TLS server already holds', () => {
    set = makeCertSet();
    const tcp = tcpServer();
    expect(() => tcpServer(tcp.server.port)).toThrow();
  });

  test('a server that began its shutdown drain never rebinds', async () => {
    set = makeCertSet();
    const tcp = tcpServer();
    const port = tcp.server.port;
    tcp.beginDrain();
    installPair(set, set.b.cert, set.b.key);
    const result = reloadServerTls([tcp], tls());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.outcome).toBe('shutting-down');
    expect(await servedFingerprint(port, 1_000)).toBeNull();
  });
});
