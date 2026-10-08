import type { Socket, TCPSocketListener } from 'bun';
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
import { loadTlsOptions } from './tls';
import type { TcpConnectionData, TcpServerConfig } from './types/tcpServer';

export type { TcpServerConfig } from './types/tcpServer';

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

  const tlsOptions = config.tls ? loadTlsOptions(config.tls) : undefined;
  const server: TCPSocketListener<TcpConnectionData> = Bun.listen<TcpConnectionData>({
    hostname: config.hostname ?? '0.0.0.0',
    port: config.port ?? 6789,
    ...(tlsOptions && { tls: tlsOptions }),
    socket: socketHandlers,
  });

  return {
    server,
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
      drainController.abort();
      server.stop(false);
    },

    stop(): void {
      // After a drain, jobs still held are abandoned to the next process's recovery.
      registry.closeAll(drainController.signal.aborted);
      server.stop(true);
    },
  };
}

export type TcpServer = ReturnType<typeof createTcpServer>;
