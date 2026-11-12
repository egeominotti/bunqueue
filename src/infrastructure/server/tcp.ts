import type { Socket, TCPSocketListener, TCPSocketListenOptions } from 'bun';
import type { QueueManager } from '../../application/queueManager';
import type { Command } from '../../domain/types/command';
import { tcpLog } from '../../shared/logger';
import { decodeMessagePack } from '../../shared/msgpack';
import { withSemaphore } from '../../shared/semaphore';
import { handleCommand } from './handler';
import { sanitizeServerError } from './errors';
import { FrameSizeError } from './protocol';
import { getRateLimiter, rateLimiterEnvConfig } from './rateLimiter';
import { TcpConnectionRegistry } from './tcp/connections';
import { resolveIdleTimeoutMs, resolveMaxWriteQueueBytes } from './tcp/constants';
import { handleEventSubscription } from './tcp/eventSubscriptions';
import { serializeTcpResponse, tcpErrorResponse } from './tcp/responses';
import { readTlsMaterial, type TlsMaterial } from './tls';
import { settleOnce, TlsReloadShuttingDownError, type TlsListenerSwap } from './tlsReload';
import type { TcpConnectionData, TcpServerConfig } from './types/tcpServer';

export type { TcpServerConfig } from './types/tcpServer';

/** Bun.listen supports `reusePort` at runtime; bun-types only declares it for connect. */
interface ReusableTcpListenOptions extends TCPSocketListenOptions<TcpConnectionData> {
  reusePort?: boolean;
}

/**
 * Create and start the MessagePack TCP server. The transport and rate-limiter settings
 * are validated before anything binds: a malformed TCP_* or RATE_LIMIT_* env var, or a
 * bad `idleTimeoutMs`/`maxWriteQueueBytes`, throws here and fails server startup.
 */
export function createTcpServer(queueManager: QueueManager, config: TcpServerConfig) {
  const idleTimeoutMs = resolveIdleTimeoutMs(config.idleTimeoutMs);
  const maxWriteQueueBytes = resolveMaxWriteQueueBytes(config.maxWriteQueueBytes);
  rateLimiterEnvConfig();
  const authTokens = new Set(config.authTokens ?? []);
  // Aborted by `beginDrain()`: pulls on every connection, parked or new, deliver nothing.
  const drainController = new AbortController();
  const registry = new TcpConnectionRegistry(
    queueManager,
    authTokens,
    idleTimeoutMs,
    maxWriteQueueBytes,
    drainController.signal
  );

  const socketHandlers = {
    open(socket: Socket<TcpConnectionData>) {
      registry.init(socket);
    },

    async data(socket: Socket<TcpConnectionData>, data: Buffer) {
      registry.init(socket);
      const { frameParser, ctx, state, semaphore, writeQueue } = socket.data;
      const rateLimiter = getRateLimiter();

      let frames: Uint8Array[];
      try {
        frames = frameParser.addData(data);
      } catch (error) {
        if (error instanceof FrameSizeError) {
          registry.clearStallTimer(socket);
          writeQueue.write(
            socket,
            tcpErrorResponse(
              `Frame too large: ${error.requestedSize} bytes exceeds maximum ${error.maxSize}`
            )
          );
          socket.end();
          return;
        }
        throw error;
      }

      registry.updateStallTimer(socket);
      const processFrame = async (frame: Uint8Array): Promise<void> => {
        let command: Command | undefined;
        try {
          command = decodeMessagePack<Command>(frame);
        } catch {
          // Invalid frames still consume protocol quota.
        }

        const requestId = typeof command?.reqId === 'string' ? command.reqId : undefined;
        if (!rateLimiter.isAllowed(state.clientId)) {
          ctx.queueManager.emitDashboardEvent('ratelimit:hit', { clientId: state.clientId });
          writeQueue.write(socket, tcpErrorResponse('Rate limit exceeded', requestId));
          registry.dropForWriteOverflow(socket);
          return;
        }

        if (!command) {
          writeQueue.write(socket, tcpErrorResponse('Invalid command format'));
          registry.dropForWriteOverflow(socket);
          return;
        }
        if (!command.cmd) {
          writeQueue.write(socket, tcpErrorResponse('Invalid command', requestId));
          registry.dropForWriteOverflow(socket);
          return;
        }

        await withSemaphore(semaphore, async () => {
          try {
            const response =
              command.cmd === 'SubscribeEvents' || command.cmd === 'UnsubscribeEvents'
                ? handleEventSubscription(command, socket, registry)
                : await handleCommand(command, ctx);
            writeQueue.write(socket, serializeTcpResponse(response));
            registry.dropForWriteOverflow(socket);
          } catch (error) {
            writeQueue.write(socket, tcpErrorResponse(sanitizeServerError(error), command.reqId));
            registry.dropForWriteOverflow(socket);
          }
        });
      };

      await Promise.all(frames.map(processFrame));
    },

    close(socket: Socket<TcpConnectionData>) {
      registry.close(socket);
    },

    error(_socket: Socket<TcpConnectionData>, error: Error) {
      tcpLog.error('Connection error', { error: error.message });
    },

    drain(socket: Socket<TcpConnectionData>) {
      if (!socket.data) return;
      if (!socket.data.writeQueue.flush(socket)) socket.terminate();
    },
  };

  const hostname = config.hostname ?? '0.0.0.0';
  // A TLS listener is replaceable (SO_REUSEPORT), so it can take a renewed certificate:
  // a new listener joins the port with the new pair, then the old one stops accepting.
  const bindTls = (port: number, material: TlsMaterial) => {
    const options: ReusableTcpListenOptions = {
      hostname,
      port,
      reusePort: true,
      tls: material,
      socket: socketHandlers,
    };
    return Bun.listen<TcpConnectionData>(options);
  };

  let server: TCPSocketListener<TcpConnectionData>;
  if (config.tls) {
    const material = readTlsMaterial(config.tls);
    const port = config.port ?? 6789;
    // SO_REUSEPORT would let a second broker silently share the port: an exclusive probe
    // bind fails with the usual address-in-use error whenever anything holds it.
    if (port !== 0) Bun.listen({ hostname, port, socket: { data() {} } }).stop(true);
    server = bindTls(port, material);
  } else {
    server = Bun.listen<TcpConnectionData>({
      hostname,
      port: config.port ?? 6789,
      socket: socketHandlers,
    });
  }
  // Set by `beginDrain()`/`stop()`: a listener that stopped accepting never rebinds.
  let closed = false;

  return {
    /** The listener now accepting connections (replaced by each TLS reload). */
    get server(): TCPSocketListener<TcpConnectionData> {
      return server;
    },
    connections: registry.connections,
    _socketHandlers: socketHandlers,

    getConnectionCount(): number {
      return registry.connections.size;
    },

    broadcast(message: unknown): void {
      registry.broadcast(message);
    },

    /**
     * Shutdown drain: stop accepting connections and handing out jobs. Existing
     * connections keep every other command (ACK, FAIL, heartbeats, PUSH, ...) so
     * workers can finish the jobs they hold before `stop()`.
     */
    beginDrain(): void {
      closed = true;
      drainController.abort();
      server.stop(false);
    },

    stop(): void {
      closed = true;
      // After a drain, jobs still held are abandoned to the next process's recovery.
      // `closeAll` also ends the connections accepted by listeners a reload retired.
      registry.closeAll(drainController.signal.aborted);
      server.stop(true);
    },

    /**
     * Bind a listener with `material` on the bound port, sharing the socket handlers (and
     * so the connection registry). `commit` retires the old listener without closing the
     * connections it accepted; `abort` drops the new one.
     */
    prepareTlsReload(material: TlsMaterial): TlsListenerSwap {
      if (!config.tls) throw new Error('TLS is not enabled on the TCP server');
      if (closed) throw new TlsReloadShuttingDownError('TCP server is shutting down');
      const previous = server;
      const next = bindTls(previous.port, material);
      return settleOnce({
        commit() {
          server = next;
          previous.stop(false);
        },
        abort() {
          next.stop(false);
        },
      });
    },
  };
}

export type TcpServer = ReturnType<typeof createTcpServer>;
