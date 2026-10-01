import { describe, expect, test } from 'bun:test';
import { createServer, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { pack, unpack } from 'msgpackr';
import { FrameParser } from '../src/infrastructure/server/protocol/frameParser';
import { createConnection as nativeConnection } from '../src/client/tcp/transport';
import {
  createConnection,
  tlsRequiresVerification,
} from '../sdk/typescript/src/canonical-transport/transport';

describe('portable canonical TCP transport', () => {
  test.each([
    ['native', nativeConnection],
    ['portable', createConnection],
  ] as const)(
    '%s preserves correlated errors and unsolicited events through fragmented frames',
    async (_name, connect) => {
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        const parser = new FrameParser();
        socket.on('data', (data) => {
          for (const payload of parser.addData(data)) {
            const command = unpack(payload);
            const response = FrameParser.frame(
              pack({ ok: false, reqId: command.reqId, error: 'denied' })
            );
            socket.write(response.subarray(0, 2));
            socket.write(
              Buffer.concat([
                response.subarray(2),
                FrameParser.frame(
                  pack({
                    type: 'event',
                    event: { eventType: 'waiting', queue: 'q', jobId: '1', timestamp: 1 },
                  })
                ),
              ])
            );
          }
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as { port: number }).port;
      const frames: Record<string, unknown>[] = [];
      let resolveFrames!: () => void;
      const received = new Promise<void>((resolve) => {
        resolveFrames = resolve;
      });
      let connection: Awaited<ReturnType<typeof createConnection>> | undefined;
      try {
        connection = await connect({ host: '127.0.0.1', port }, 1000, {
          onData: (frame) => {
            frames.push(unpack(frame));
            if (frames.length === 2) resolveFrames();
          },
          onClose: () => {},
          onError: (error) => {
            throw error;
          },
        });
        connection.socket.write(FrameParser.frame(pack({ cmd: 'Ping', reqId: '7' })));
        await received;
        expect(frames[0]).toEqual({ ok: false, reqId: '7', error: 'denied' });
        expect(frames[1].type).toBe('event');
      } finally {
        connection?.socket.end();
        for (const socket of sockets) socket.destroy();
        server.close();
        await once(server, 'close');
      }
    }
  );

  test('TLS verifies by default and requires explicit opt out', () => {
    expect(tlsRequiresVerification(undefined)).toBe(false);
    expect(tlsRequiresVerification(true)).toBe(true);
    expect(tlsRequiresVerification({})).toBe(true);
    expect(tlsRequiresVerification({ rejectUnauthorized: false })).toBe(false);
  });

  // A connection that never opened only fails the attempt. Reporting it as a
  // close would run the client's lost-connection path and reject every queued
  // command instead of letting the canonical reconnect loop retry.
  test.each([
    ['native', nativeConnection],
    ['portable', createConnection],
  ] as const)('%s fails a refused connection without reporting a close', async (_name, connect) => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    server.close();
    await once(server, 'close');
    const events: string[] = [];
    await expect(
      connect({ host: '127.0.0.1', port }, 1000, {
        onData: () => {},
        onClose: () => events.push('close'),
        onError: (error) => events.push(`error:${error.message}`),
      })
    ).rejects.toThrow(`Failed to connect to 127.0.0.1:${port}`);
    // Node emits the socket close on a later tick; give it ample time to surface.
    await Bun.sleep(100);
    expect(events).toEqual([]);
  });

  // Bun opens the TCP socket before TLS verification fails, so its close is
  // reported; the portable transport must report exactly one close as well.
  test.each([
    ['native', nativeConnection],
    ['portable', createConnection],
  ] as const)(
    '%s reports one close when TLS verification fails after TCP opened',
    async (_name, connect) => {
      const directory = mkdtempSync(join(tmpdir(), 'bq-transport-tls-'));
      const cert = join(directory, 'cert.pem');
      const key = join(directory, 'key.pem');
      const generated = Bun.spawnSync([
        'openssl',
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-nodes',
        '-subj',
        '/CN=localhost',
      ]);
      if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
      const server = createTlsServer({ cert: readFileSync(cert), key: readFileSync(key) }, (s) =>
        s.on('error', () => {})
      );
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as { port: number }).port;
      const events: string[] = [];
      let reportClose!: () => void;
      const reported = new Promise<void>((resolve) => {
        reportClose = resolve;
      });
      try {
        // The self-signed certificate is not trusted by default.
        await expect(
          connect({ host: '127.0.0.1', port, tls: true }, 2000, {
            onData: () => {},
            onClose: () => {
              events.push('close');
              reportClose();
            },
            onError: (error) => events.push(`error:${error.message}`),
          })
        ).rejects.toThrow('127.0.0.1');
        // Bun closes after a graceful end(); wait for it, then for any duplicate.
        await Promise.race([reported, Bun.sleep(5000)]);
        await Bun.sleep(50);
        expect(events).toEqual(['close']);
      } finally {
        server.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  test('rejects oversized frames and closes the peer connection', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', () => {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(64 * 1024 * 1024 + 1);
        socket.write(header);
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    let error: Error | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let connection: Awaited<ReturnType<typeof createConnection>> | undefined;
    try {
      connection = await createConnection({ host: '127.0.0.1', port }, 1000, {
        onData: () => {
          throw new Error('Oversized frame was accepted');
        },
        onClose: resolveClosed,
        onError: (reason) => {
          error = reason;
        },
      });
      connection.socket.write('request');
      await closed;
      expect(error?.message).toBe('Frame too large: 67108865 bytes exceeds maximum 67108864');
    } finally {
      connection?.socket.end();
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    }
  });
});
