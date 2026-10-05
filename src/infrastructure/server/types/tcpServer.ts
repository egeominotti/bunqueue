import type { FrameParser } from '../protocol';
import type { ConnectionState } from './protocol';
import type { HandlerContext } from '../types';
import type { Semaphore } from '../../../shared/semaphore';
import type { SafeTimer } from '../../../shared/timers';
import type { SocketWriteQueue } from '../socketWriteQueue';
import type { TlsServerOptions } from '../tls';

export interface TcpServerConfig {
  port?: number;
  hostname?: string;
  authTokens?: string[];
  /** Slowloris stall timeout, finite ms >= 0 (0 disables); default TCP_IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
  /** Outbound buffer cap, whole bytes >= 0 (0 disables); default TCP_MAX_WRITE_QUEUE_BYTES. */
  maxWriteQueueBytes?: number;
  tls?: TlsServerOptions;
}

export interface TcpConnectionData {
  state: ConnectionState;
  abortController: AbortController;
  frameParser: FrameParser;
  ctx: HandlerContext;
  semaphore: Semaphore;
  writeQueue: SocketWriteQueue;
  stallTimer: SafeTimer | null;
  /** A dedicated event connection may own exactly one queue subscription. */
  eventQueue: string | null;
}
