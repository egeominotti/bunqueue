/**
 * The HTTP server's listening socket (Bun.serve).
 *
 * Plain HTTP binds once, as it always did. With TLS the listener is replaceable, so a
 * reload can serve a renewed certificate (Bun ignores `reload({ tls })`):
 * - on a port, a new listener joins the bound port (SO_REUSEPORT) with the new pair and
 *   the old one stops accepting gracefully, keeping its requests and WebSockets;
 * - on a unix socket, which cannot be shared, the old listener stops first and the new
 *   one binds the path; a failed bind rebinds the bytes served before. Either way the
 *   new socket file gets the mode (and, when permitted, the owner) the old one had.
 */

import type { Server, WebSocketHandler } from 'bun';
import { chmodSync, chownSync, statSync } from 'node:fs';
import { serverLog } from '../../shared/logger';
import { readTlsMaterial, type TlsMaterial, type TlsServerOptions } from './tls';
import {
  settleOnce,
  TlsReloadDegradedError,
  TlsReloadShuttingDownError,
  type TlsListenerSwap,
} from './tlsReload';
import type { WsData } from './wsHandler';

export interface HttpListenerConfig {
  port?: number;
  hostname?: string;
  socketPath?: string;
  tls?: TlsServerOptions;
}

export interface HttpListenerHandlers {
  fetch(req: Request, server: Server<WsData>): Promise<Response | undefined>;
  websocket: WebSocketHandler<WsData>;
}

export interface HttpListener {
  /** The listener now accepting connections (replaced by each TLS reload). */
  readonly server: Server<WsData>;
  /** Stop accepting (open requests and WebSockets stay served); never rebinds after. */
  stop(): void;
  /** Bind a listener with `material`; throws without TLS, after `stop()`, or on bind. */
  prepareTlsReload(material: TlsMaterial): TlsListenerSwap;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Mode and owner of a unix socket file, re-applied after the path is bound again. */
interface SocketFileAttributes {
  mode: number;
  uid: number;
  gid: number;
}

function readSocketAttributes(path: string): SocketFileAttributes | null {
  try {
    const stats = statSync(path);
    return { mode: stats.mode & 0o7777, uid: stats.uid, gid: stats.gid };
  } catch {
    return null; // The path is gone: there is nothing to restore.
  }
}

/**
 * Re-apply what an operator set on the socket file (`chmod 660`, `chgrp`) after startup.
 * An owner/group the process may not set (EPERM) is kept as created, with a warning.
 */
function restoreSocketAttributes(path: string, attributes: SocketFileAttributes | null): void {
  if (!attributes) return;
  const created = statSync(path);
  if (created.uid !== attributes.uid || created.gid !== attributes.gid) {
    try {
      chownSync(path, attributes.uid, attributes.gid);
    } catch (error) {
      // Without privileges a process can only pick one of its own groups: keep the default.
      if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
      serverLog.warn('HTTP unix socket owner not restored after a TLS reload', {
        path,
        uid: attributes.uid,
        gid: attributes.gid,
        keptUid: created.uid,
        keptGid: created.gid,
        error: error.message,
      });
    }
  }
  chmodSync(path, attributes.mode);
}

/** Validate the TLS files and bind the HTTP listener. */
export function createHttpListener(
  config: HttpListenerConfig,
  { fetch, websocket }: HttpListenerHandlers
): HttpListener {
  // Validate the TLS files BEFORE binding: fail fast on a bad path.
  let served = config.tls ? readTlsMaterial(config.tls) : undefined;
  const hostname = config.hostname ?? '0.0.0.0';
  const socketPath = config.socketPath;
  const serveUnix = (path: string, tls: TlsMaterial | undefined) =>
    Bun.serve<WsData>({ unix: path, ...(tls && { tls }), fetch, websocket });
  /**
   * Bind `path` and give the new socket file `attributes`. For the new pair a restore
   * failure is a bind failure (the path is unbound again and the reload rolls back); on a
   * rollback the listener serving the previous pair stays up and the failure is logged.
   */
  const rebindUnix = (
    path: string,
    tls: TlsMaterial | undefined,
    attributes: SocketFileAttributes | null,
    rollback: boolean
  ) => {
    const bound = serveUnix(path, tls);
    try {
      restoreSocketAttributes(path, attributes);
    } catch (error) {
      if (rollback) {
        serverLog.warn('HTTP unix socket permissions not restored after a TLS reload rollback', {
          path,
          mode: attributes?.mode.toString(8),
          error: errorMessage(error),
        });
        return bound;
      }
      void bound.stop();
      throw error;
    }
    return bound;
  };
  const serveTlsPort = (port: number, tls: TlsMaterial) =>
    Bun.serve<WsData>({ hostname, port, reusePort: true, tls, fetch, websocket });

  let server: Server<WsData>;
  if (socketPath) {
    server = serveUnix(socketPath, served);
  } else if (served) {
    const port = config.port ?? 6790;
    // SO_REUSEPORT would let a second broker silently share the port: an exclusive probe
    // bind fails with the usual address-in-use error whenever anything holds it.
    if (port !== 0) void Bun.serve({ hostname, port, fetch: () => new Response(null) }).stop(true);
    server = serveTlsPort(port, served);
  } else {
    server = Bun.serve<WsData>({ hostname, port: config.port ?? 6790, fetch, websocket });
  }
  let closed = false;

  const preparePort = (material: TlsMaterial): TlsListenerSwap => {
    const previous = server;
    if (previous.port === undefined) throw new Error('HTTP listener has no bound port');
    const next = serveTlsPort(previous.port, material);
    return {
      commit() {
        server = next;
        served = material;
        void previous.stop();
      },
      abort() {
        void next.stop();
      },
    };
  };

  const prepareUnix = (path: string, material: TlsMaterial): TlsListenerSwap => {
    const previous = server;
    const previousMaterial = served;
    const attributes = readSocketAttributes(path);
    // A unix path cannot be shared: free it (`stop()` unlinks it), then bind it again.
    void previous.stop();
    const rebindPrevious = () => {
      server = rebindUnix(path, previousMaterial, attributes, true);
    };
    let next: Server<WsData>;
    try {
      next = rebindUnix(path, material, attributes, false);
    } catch (error) {
      try {
        rebindPrevious();
      } catch (rebindError) {
        throw new TlsReloadDegradedError(
          `${errorMessage(error)}; rebinding the previous certificate failed: ${errorMessage(rebindError)}`
        );
      }
      throw error;
    }
    return {
      commit() {
        server = next;
        served = material;
      },
      abort() {
        void next.stop();
        rebindPrevious();
      },
    };
  };

  return {
    get server() {
      return server;
    },
    stop() {
      closed = true;
      void server.stop();
    },
    prepareTlsReload(material) {
      if (!served) throw new Error('TLS is not enabled on the HTTP server');
      if (closed) throw new TlsReloadShuttingDownError('HTTP server is shutting down');
      return settleOnce(socketPath ? prepareUnix(socketPath, material) : preparePort(material));
    },
  };
}
