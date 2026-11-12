/**
 * Doubles for the TLS certificate reload tests (issue #189):
 *
 * - `makeCertSet()`: two self-signed EC certificates for localhost/127.0.0.1 ("a" is
 *   the current one, "b" the renewed one) plus a "live" cert/key path pair that the
 *   server is pointed at, in a fresh temporary directory;
 * - `installPair(set, cert, key)`: replace the live files the way an ACME deploy hook
 *   does (write a sibling, then rename over the live path);
 * - `servedFingerprint(target)`: the SHA-256 fingerprint of the certificate a new TLS
 *   handshake receives on a TCP port or a unix socket path (null when it fails);
 * - `PingConnection`: one long-lived TLS connection to the msgpack TCP protocol that
 *   sends `Ping` frames, so a test can prove the same connection survives a reload.
 */

import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type TLSSocket } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pack, unpack } from 'msgpackr';
import { FrameParser } from '../src/infrastructure/server/protocol';

export interface CertPair {
  readonly cert: string;
  readonly key: string;
  readonly fingerprint: string;
  /** `validTo` as an ISO-8601 string. */
  readonly notAfter: string;
}

export interface CertSet {
  readonly dir: string;
  readonly a: CertPair;
  readonly b: CertPair;
  readonly live: { readonly cert: string; readonly key: string };
  cleanup(): void;
}

function generatePair(dir: string, name: string, days: number): CertPair {
  const cert = join(dir, `${name}-cert.pem`);
  const key = join(dir, `${name}-key.pem`);
  const generated = Bun.spawnSync([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    String(days),
    '-subj',
    `/CN=localhost-${name}`,
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
  const x509 = new X509Certificate(readFileSync(cert));
  return {
    cert,
    key,
    fingerprint: x509.fingerprint256,
    notAfter: x509.validToDate.toISOString(),
  };
}

export function makeCertSet(): CertSet {
  const dir = mkdtempSync(join(tmpdir(), 'bq-tls-reload-'));
  // Different lifetimes, so the two expiry dates always differ.
  const a = generatePair(dir, 'a', 2);
  const b = generatePair(dir, 'b', 9);
  const live = { cert: join(dir, 'live-cert.pem'), key: join(dir, 'live-key.pem') };
  const set: CertSet = {
    dir,
    a,
    b,
    live,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  installPair(set, a.cert, a.key);
  return set;
}

/** Atomically replace the live cert and key with copies of `cert` and `key`. */
export function installPair(set: CertSet, cert: string, key: string): void {
  writeFileSync(`${set.live.cert}.new`, readFileSync(cert));
  renameSync(`${set.live.cert}.new`, set.live.cert);
  writeFileSync(`${set.live.key}.new`, readFileSync(key));
  renameSync(`${set.live.key}.new`, set.live.key);
}

/** Fingerprint served to a NEW handshake on `target` (a port or a unix socket path). */
export function servedFingerprint(
  target: number | string,
  timeoutMs = 3_000
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const options =
      typeof target === 'number'
        ? { host: '127.0.0.1', port: target, rejectUnauthorized: false }
        : { path: target, rejectUnauthorized: false };
    const socket = connect(options, () => {
      const fingerprint = socket.getPeerCertificate().fingerprint256 ?? null;
      finish(fingerprint);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(value: string | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    }
    socket.on('error', () => finish(null));
  });
}

/** Poll until `target` serves `fingerprint` or `timeoutMs` elapses; returns the last one. */
export async function waitForServed(
  target: number | string,
  fingerprint: string,
  timeoutMs = 5_000
): Promise<string | null> {
  const startedAt = Date.now();
  let served = await servedFingerprint(target);
  while (served !== fingerprint && Date.now() - startedAt < timeoutMs) {
    await Bun.sleep(50);
    served = await servedFingerprint(target);
  }
  return served;
}

/** A single TLS connection to the TCP protocol that answers `Ping` frames. */
export class PingConnection {
  private readonly parser = new FrameParser();
  private readonly waiters: Array<(response: Record<string, unknown> | null) => void> = [];
  private socket: TLSSocket | null = null;
  closed = false;
  fingerprint: string | null = null;

  static async open(port: number): Promise<PingConnection> {
    const connection = new PingConnection();
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
        connection.fingerprint = socket.getPeerCertificate().fingerprint256 ?? null;
        resolve();
      });
      connection.socket = socket;
      socket.on('data', (data: Buffer) => {
        for (const frame of connection.parser.addData(new Uint8Array(data))) {
          connection.waiters.shift()?.(unpack(frame) as Record<string, unknown>);
        }
      });
      socket.on('error', reject);
      socket.on('close', () => {
        connection.closed = true;
        for (const waiter of connection.waiters.splice(0)) waiter(null);
      });
    });
    return connection;
  }

  /** Send one Ping; resolves with the response, or null on close or timeout. */
  ping(timeoutMs = 3_000): Promise<Record<string, unknown> | null> {
    if (this.closed || !this.socket) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.waiters.push((response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.socket!.write(FrameParser.frame(pack({ cmd: 'Ping', reqId: 'tls-reload' })));
    });
  }

  close(): void {
    this.socket?.destroy();
  }
}

/** A free TCP port on 127.0.0.1 (bound and released at once). */
export function freePort(): number {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}
