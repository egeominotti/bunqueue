/**
 * TLS doubles for the TCP client tests:
 *
 * - `tlsMaterial()`: a self-signed certificate for 127.0.0.1/localhost, generated
 *   once per process with openssl (the files are removed at once, the PEMs kept);
 * - `startGate(targetPort, stalled)`: a plain TCP relay. Its first `stalled`
 *   connections are accepted and never answered (a TLS handshake against them stalls
 *   until `connectTimeout`); later ones are relayed byte for byte to `targetPort`.
 *   `endStalled()` ends the stalled ones from the server side.
 *
 * Servers are registered with `trackServer`, so `cleanup()` stops them.
 */

import type { Socket } from 'bun';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackServer, type Connections } from './tcp-client-support';

let material: { cert: string; key: string } | undefined;

export function tlsMaterial(): { cert: string; key: string } {
  if (material) return material;
  const directory = mkdtempSync(join(tmpdir(), 'bq-tcp-client-tls-'));
  try {
    const cert = join(directory, 'cert.pem');
    const key = join(directory, 'key.pem');
    const generated = Bun.spawnSync([
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ]);
    if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
    material = { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') };
    return material;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

interface Relay {
  stalled: boolean;
  upstream: Socket<undefined> | null;
  pending: Uint8Array[];
  closed: boolean;
}

export interface Gate extends Connections {
  port: number;
  /** End every stalled connection from the server side. */
  endStalled(): void;
}

export function startGate(targetPort: number, stalled: number): Gate {
  let accepted = 0;
  const open = new Set<Socket<Relay>>();
  const server = Bun.listen<Relay>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        accepted++;
        open.add(socket);
        const relay: Relay = {
          stalled: accepted <= stalled,
          upstream: null,
          pending: [],
          closed: false,
        };
        socket.data = relay;
        if (relay.stalled) return;
        void Bun.connect<undefined>({
          hostname: '127.0.0.1',
          port: targetPort,
          socket: {
            open(upstream) {
              relay.upstream = upstream;
              for (const chunk of relay.pending.splice(0)) upstream.write(chunk);
              if (relay.closed) upstream.end();
            },
            data(_upstream, chunk) {
              socket.write(chunk);
            },
            close() {
              if (!relay.closed) socket.end();
            },
            error() {},
          },
        }).catch(() => socket.end());
      },
      data(socket, chunk) {
        const relay = socket.data;
        if (relay.stalled) return;
        if (relay.upstream) relay.upstream.write(chunk);
        else relay.pending.push(new Uint8Array(chunk));
      },
      close(socket) {
        open.delete(socket);
        socket.data.closed = true;
        socket.data.upstream?.end();
      },
      error() {},
    },
  });
  trackServer(server);
  return {
    port: server.port,
    accepted: () => accepted,
    open: () => open.size,
    endStalled: () => {
      for (const socket of open) if (socket.data.stalled) socket.end();
    },
  };
}
