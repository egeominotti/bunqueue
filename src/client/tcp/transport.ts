import { readFileSync } from 'node:fs';
import type { Socket } from 'bun';
import { FrameParser, FrameSizeError } from '../../infrastructure/server/protocol';
import { SocketWriteQueue } from '../../infrastructure/server/socketWriteQueue';
import { safeTimeout, type SafeTimer } from '../../shared/timers';
import type { ClientTlsOptions, SocketWrapper } from './types';

const CLIENT_MAX_WRITE_QUEUE_BYTES = 64 * 1024 * 1024;

/**
 * Socket events of one attempt. A failed attempt (refused, timed out, TLS rejected)
 * never reports data or errors after it failed; it reports its close only when its TCP
 * connection opened while the attempt was pending, as Bun does, so a refused or
 * abandoned attempt keeps the client's queued commands for the next attempt.
 */
export interface ConnectionEvents {
  onData: (frame: Uint8Array) => void;
  onClose: () => void;
  onError: (error: Error) => void;
}

export interface ConnectionResult {
  socket: SocketWrapper;
  cleanup: () => void;
}

export interface ConnectionTarget {
  host?: string;
  port?: number;
  tls?: boolean | ClientTlsOptions;
}

export function buildClientTls(
  tls: boolean | ClientTlsOptions | undefined
): true | Record<string, unknown> | undefined {
  if (!tls) return undefined;
  if (tls === true) return true;
  return {
    ...(tls.rejectUnauthorized !== undefined && { rejectUnauthorized: tls.rejectUnauthorized }),
    ...(tls.caFile !== undefined && { ca: readFileSync(tls.caFile) }),
  };
}

export function tlsRequiresVerification(tls: boolean | ClientTlsOptions | undefined): boolean {
  if (!tls) return false;
  if (tls === true) return true;
  return tls.rejectUnauthorized !== false;
}

type AttemptState = 'pending' | 'open' | 'failed';

function terminate(socket: Socket<unknown> | null): void {
  try {
    socket?.terminate();
  } catch {
    // Already closed.
  }
}

/**
 * Open one connection. The promise resolves once TCP (and TLS, verified unless opted
 * out) is up, or rejects on a refusal, a TLS rejection, a close or `connectTimeout`. A
 * timed-out attempt closes its socket, and a socket that opens after its attempt failed
 * is closed at once, so an abandoned attempt never leaves a connection on the broker.
 */
export function createConnection(
  target: ConnectionTarget,
  connectTimeout: number,
  events: ConnectionEvents
): Promise<ConnectionResult> {
  return new Promise((resolve, reject) => {
    const writeQueue = new SocketWriteQueue(CLIENT_MAX_WRITE_QUEUE_BYTES);
    const socketData: SocketWrapper = {
      write: () => undefined,
      end: () => undefined,
      frameParser: new FrameParser(),
    };

    let state: AttemptState = 'pending';
    // The socket once Bun reports it, so a failed attempt can close it.
    let rawSocket: Socket<unknown> | null = null;
    // TCP opened while the attempt was pending: only such a socket reports its close.
    let tcpOpened = false;
    let connectTimer: SafeTimer | null = null;
    const tlsValue = buildClientTls(target.tls);
    const isTls = tlsValue !== undefined;
    const verifyTls = tlsRequiresVerification(target.tls);
    let handshakeOk = !isTls;

    const cleanup = () => {
      if (connectTimer) {
        connectTimer.clear();
        connectTimer = null;
      }
    };
    /** Fail a pending attempt; `abandon` also closes the socket it already holds. */
    const fail = (error: Error, abandon: boolean) => {
      if (state !== 'pending') return;
      state = 'failed';
      cleanup();
      reject(error);
      if (abandon) terminate(rawSocket);
    };
    const maybeResolveOpen = () => {
      if (state === 'pending' && tcpOpened && handshakeOk) {
        state = 'open';
        cleanup();
        resolve({ socket: socketData, cleanup });
      }
    };

    const targetDescription = `${target.host}:${target.port}`;
    // Armed before the socket, so a delay safeTimeout refuses (NaN) throws before
    // anything opens; it honours a connectTimeout above 2^31 - 1 ms.
    connectTimer = safeTimeout(() => {
      fail(new Error(`Connection timeout to ${targetDescription}`), true);
    }, connectTimeout);
    const socketHandlers = {
      data(_socket: Socket<unknown>, data: Buffer) {
        if (state === 'failed') return;
        let frames: Uint8Array[];
        try {
          frames = socketData.frameParser.addData(data);
        } catch (error) {
          if (error instanceof FrameSizeError) {
            events.onError(
              new Error(
                `Frame too large: ${error.requestedSize} bytes exceeds maximum ${error.maxSize}`
              )
            );
            return;
          }
          throw error;
        }
        for (const frame of frames) events.onData(frame);
      },
      open(socket: Socket<unknown>) {
        rawSocket = socket;
        if (state !== 'pending') {
          // A late socket of an attempt that already failed never reaches the client.
          terminate(socket);
          return;
        }
        tcpOpened = true;
        try {
          (
            socket as unknown as { setKeepAlive?: (enable: boolean, delayMs?: number) => void }
          ).setKeepAlive?.(true, 15000);
        } catch {
          // Keepalive is best-effort.
        }
        socketData.write = (data: Uint8Array | string) => {
          const bytes = typeof data === 'string' ? Buffer.from(data) : data;
          if (!writeQueue.write(socket, bytes) || writeQueue.isOverBudget) {
            writeQueue.clear();
            socket.terminate();
          }
        };
        socketData.end = () => {
          writeQueue.clear();
          socket.end();
        };
        maybeResolveOpen();
      },
      handshake(socket: Socket<unknown>, success: boolean, authorizationError: Error | null) {
        if (state === 'failed') {
          terminate(socket);
          return;
        }
        if (verifyTls && (!success || authorizationError)) {
          const reason = authorizationError?.message ?? 'handshake failed';
          fail(new Error(`TLS verification failed for ${targetDescription}: ${reason}`), false);
          try {
            socket.end();
          } catch {
            // Socket is already closing.
          }
          return;
        }
        handshakeOk = true;
        maybeResolveOpen();
      },
      close() {
        writeQueue.clear();
        fail(new Error('Connection closed'), false);
        if (tcpOpened) events.onClose();
      },
      drain(socket: Socket<unknown>) {
        if (!writeQueue.flush(socket)) {
          writeQueue.clear();
          socket.terminate();
        }
      },
      error(_socket: Socket<unknown>, error: Error) {
        // An abandoned socket's errors never reach the client.
        if (state === 'failed') return;
        fail(new Error(`Connection error: ${error.message}`), false);
        events.onError(error);
      },
      connectError(_socket: Socket<unknown>, error: Error) {
        fail(new Error(`Failed to connect to ${targetDescription}: ${error.message}`), false);
      },
    };

    try {
      void (Bun.connect as (opts: unknown) => Promise<Socket<unknown>>)({
        hostname: target.host ?? 'localhost',
        port: target.port ?? 6789,
        ...(tlsValue !== undefined && { tls: tlsValue }),
        socket: socketHandlers,
      }).then(
        (socket) => {
          rawSocket ??= socket;
          if (state === 'failed') terminate(socket);
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          fail(new Error(`Failed to connect to ${targetDescription}: ${message}`), false);
        }
      );
    } catch (error) {
      // Bun.connect throws synchronously for options it refuses (an invalid port):
      // the promise rejects with that error, as before, without a timer left armed.
      state = 'failed';
      cleanup();
      throw error;
    }
  });
}
