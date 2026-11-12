/**
 * REPRO — issue #189: a renewed TLS certificate is only served after a full restart.
 *
 * Run: bun test test/repro-issue-189-tls-reload-process.test.ts
 *
 * The broker reads TLS_CERT_FILE / TLS_KEY_FILE once, when it binds its TCP and HTTP
 * listeners. Before the fix, replacing the files on disk changed nothing until a
 * restart, and SIGHUP was not handled: the default action killed the process (exit
 * 129) without the graceful drain SIGTERM gets, so every renewal dropped every client.
 *
 * Contract pinned here, against the real broker process (`src/main.ts`):
 * - with TLS configured, SIGHUP re-reads the cert and key: new handshakes on BOTH
 *   ports get the renewed certificate, the process keeps running, a connection opened
 *   before the reload keeps working on the same socket, and one log line names the
 *   new certificate's expiry and fingerprint;
 * - a pair that cannot be loaded (cert/key mismatch, missing file) is refused: the
 *   broker logs the error and keeps serving the current certificate; a later good
 *   pair is picked up by the next SIGHUP;
 * - without TLS the broker installs no SIGHUP handler, so the signal keeps exactly the
 *   effect it had in 2.9.21 (the default action, or an inherited "ignore" such as
 *   `nohup`'s: a non-TLS broker under `nohup` keeps running). A TLS broker reloads,
 *   also under `nohup`;
 * - a second broker still cannot bind a port the TLS broker is listening on, and
 *   fails with the address-in-use startup error.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  freePort,
  installPair,
  makeCertSet,
  PingConnection,
  servedFingerprint,
  waitForServed,
  type CertSet,
} from './tls-reload-support';

type Subprocess = ReturnType<typeof Bun.spawn>;

interface Broker {
  readonly proc: Subprocess;
  readonly tcpPort: number;
  readonly httpPort: number;
  /** Everything the process wrote to stdout and stderr so far. */
  output(): string;
}

const cleanups: Array<() => void | Promise<void>> = [];

/** The startup error of a bind that found the port taken (TCP or HTTP listener). */
const ADDRESS_IN_USE = /Failed to start server: (Failed to listen at|.*in use)/;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function drainInto(stream: ReadableStream<Uint8Array>, sink: string[]): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) sink.push(decoder.decode(chunk, { stream: true }));
}

async function waitPort(port: number, proc: Subprocess, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode !== null) throw new Error(`broker exited with ${proc.exitCode}`);
    try {
      const socket = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } });
      socket.end();
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error(`broker not ready on :${port}`);
}

/** Spawn a broker. `wait: false` returns as soon as it is spawned (for bind failures). */
async function startBroker(
  options: {
    tls?: CertSet;
    tcpPort?: number;
    httpPort?: number;
    wait?: boolean;
    /** Start under `nohup`, so the broker inherits SIGHUP as ignored. */
    nohup?: boolean;
  } = {}
): Promise<Broker> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bq-tls-reload-db-'));
  const tcpPort = options.tcpPort ?? freePort();
  const httpPort = options.httpPort ?? freePort();
  const command = [process.execPath, 'run', 'src/main.ts'];
  const proc = Bun.spawn(options.nohup ? ['nohup', ...command] : command, {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      BUNQUEUE_EMBEDDED: '',
      HOST: '127.0.0.1',
      TCP_PORT: String(tcpPort),
      HTTP_PORT: String(httpPort),
      BUNQUEUE_DATA_PATH: join(dataDir, 'bunq.db'),
      SHUTDOWN_TIMEOUT_MS: '2000',
      LOG_LEVEL: 'info',
      LOG_FORMAT: 'json',
      TLS_CERT_FILE: options.tls?.live.cert ?? '',
      TLS_KEY_FILE: options.tls?.live.key ?? '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const sink: string[] = [];
  const readers = [drainInto(proc.stdout, sink), drainInto(proc.stderr, sink)];
  cleanups.push(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await proc.exited;
    await Promise.allSettled(readers);
    rmSync(dataDir, { recursive: true, force: true });
  });
  const broker: Broker = { proc, tcpPort, httpPort, output: () => sink.join('') };
  if (options.wait !== false) {
    await waitPort(tcpPort, proc);
    await waitPort(httpPort, proc);
  }
  return broker;
}

function certs(): CertSet {
  const set = makeCertSet();
  cleanups.push(() => set.cleanup());
  return set;
}

/** Wait until `text` has appeared `times` times in the broker output. */
async function waitForLog(broker: Broker, text: string, times = 1, timeoutMs = 5_000) {
  const startedAt = Date.now();
  const count = () => broker.output().split(text).length - 1;
  while (count() < times && Date.now() - startedAt < timeoutMs) await Bun.sleep(25);
  return count();
}

function alive(broker: Broker): boolean {
  return broker.proc.exitCode === null && broker.proc.signalCode === null;
}

describe('issue #189: SIGHUP reloads the TLS certificate without a restart', () => {
  test('new handshakes on both ports get the renewed certificate; open connections stay', async () => {
    const set = certs();
    const broker = await startBroker({ tls: set });
    expect(await servedFingerprint(broker.tcpPort)).toBe(set.a.fingerprint);
    expect(await servedFingerprint(broker.httpPort)).toBe(set.a.fingerprint);

    const before = await PingConnection.open(broker.tcpPort);
    cleanups.push(() => before.close());
    expect(before.fingerprint).toBe(set.a.fingerprint);
    expect((await before.ping())?.ok).toBe(true);

    installPair(set, set.b.cert, set.b.key);
    // Files alone change nothing until the operator signals the broker.
    expect(await servedFingerprint(broker.tcpPort)).toBe(set.a.fingerprint);
    broker.proc.kill('SIGHUP');

    expect(await waitForServed(broker.tcpPort, set.b.fingerprint)).toBe(set.b.fingerprint);
    expect(await waitForServed(broker.httpPort, set.b.fingerprint)).toBe(set.b.fingerprint);
    expect(alive(broker)).toBe(true);

    // The connection opened on the old certificate is the same socket and still served.
    expect((await before.ping())?.ok).toBe(true);
    expect(before.closed).toBe(false);

    // One log line per reload, naming the new certificate.
    expect(await waitForLog(broker, 'TLS certificate reloaded')).toBe(1);
    const reloadLine = broker
      .output()
      .split('\n')
      .find((line) => line.includes('TLS certificate reloaded'));
    expect(reloadLine).toContain(set.b.notAfter);
    expect(reloadLine).toContain(set.b.fingerprint);

    // A second renewal works the same way (A again).
    installPair(set, set.a.cert, set.a.key);
    broker.proc.kill('SIGHUP');
    expect(await waitForServed(broker.tcpPort, set.a.fingerprint)).toBe(set.a.fingerprint);
    expect(await waitForServed(broker.httpPort, set.a.fingerprint)).toBe(set.a.fingerprint);
    expect(await waitForLog(broker, 'TLS certificate reloaded', 2)).toBe(2);
    expect((await before.ping())?.ok).toBe(true);

    // Graceful shutdown still works after reloads.
    before.close();
    broker.proc.kill('SIGTERM');
    expect(await broker.proc.exited).toBe(0);
  }, 60_000);

  test('a pair that cannot be loaded keeps the current certificate and the process', async () => {
    const set = certs();
    const broker = await startBroker({ tls: set });

    // Mismatched cert and key.
    installPair(set, set.b.cert, set.a.key);
    broker.proc.kill('SIGHUP');
    expect(await waitForLog(broker, 'TLS reload failed')).toBe(1);
    expect(alive(broker)).toBe(true);
    expect(await servedFingerprint(broker.tcpPort)).toBe(set.a.fingerprint);
    expect(await servedFingerprint(broker.httpPort)).toBe(set.a.fingerprint);

    // Missing key file.
    rmSync(set.live.key);
    broker.proc.kill('SIGHUP');
    expect(await waitForLog(broker, 'TLS reload failed', 2)).toBe(2);
    expect(alive(broker)).toBe(true);
    expect(await servedFingerprint(broker.tcpPort)).toBe(set.a.fingerprint);
    expect(await servedFingerprint(broker.httpPort)).toBe(set.a.fingerprint);
    expect(broker.output()).not.toContain('TLS certificate reloaded');

    // The next good pair is picked up.
    installPair(set, set.b.cert, set.b.key);
    broker.proc.kill('SIGHUP');
    expect(await waitForServed(broker.tcpPort, set.b.fingerprint)).toBe(set.b.fingerprint);
    expect(await waitForServed(broker.httpPort, set.b.fingerprint)).toBe(set.b.fingerprint);
    expect(alive(broker)).toBe(true);
  }, 60_000);

  test('without TLS, a broker started under nohup still survives SIGHUP', async () => {
    const broker = await startBroker({ nohup: true });
    broker.proc.kill('SIGHUP');
    await Bun.sleep(500);
    expect(alive(broker)).toBe(true);
    await waitPort(broker.tcpPort, broker.proc);
    broker.proc.kill('SIGTERM');
    expect(await broker.proc.exited).toBe(0);
  }, 60_000);

  test('with TLS, a broker started under nohup reloads on SIGHUP', async () => {
    const set = certs();
    const broker = await startBroker({ tls: set, nohup: true });
    installPair(set, set.b.cert, set.b.key);
    broker.proc.kill('SIGHUP');
    expect(await waitForServed(broker.tcpPort, set.b.fingerprint)).toBe(set.b.fingerprint);
    expect(await waitForServed(broker.httpPort, set.b.fingerprint)).toBe(set.b.fingerprint);
    expect(alive(broker)).toBe(true);
  }, 60_000);

  test('a second broker still cannot bind the ports of a TLS broker', async () => {
    const set = certs();
    const first = await startBroker({ tls: set });

    const sameTcp = await startBroker({ tls: set, tcpPort: first.tcpPort, wait: false });
    expect(await sameTcp.proc.exited).not.toBe(0);
    expect(sameTcp.output()).toMatch(ADDRESS_IN_USE);

    const sameHttp = await startBroker({ tls: set, httpPort: first.httpPort, wait: false });
    expect(await sameHttp.proc.exited).not.toBe(0);
    expect(sameHttp.output()).toMatch(ADDRESS_IN_USE);

    // The first broker is untouched, also after a reload.
    first.proc.kill('SIGHUP');
    expect(await waitForLog(first, 'TLS certificate reloaded')).toBe(1);
    const afterReload = await startBroker({ tls: set, tcpPort: first.tcpPort, wait: false });
    expect(await afterReload.proc.exited).not.toBe(0);
    expect(afterReload.output()).toMatch(ADDRESS_IN_USE);
    expect(alive(first)).toBe(true);
    expect(await servedFingerprint(first.tcpPort)).toBe(set.a.fingerprint);
  }, 60_000);
});
