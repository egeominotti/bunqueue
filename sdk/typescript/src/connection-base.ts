/**
 * Connection lifecycle shared by {@link Connection}: options, the lazy connect with
 * its reconnect backoff window, Auth, response dispatch and teardown. Command
 * pipelining (`call`, `ping`, `hello`, `close`) lives in connection.ts; the split
 * mirrors worker-base.ts / worker.ts.
 */

import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { unpack } from 'msgpackr';
import { Backpressure } from './backpressure.js';
import type {
  Command,
  ConnectionOptions,
  Pending,
  Response,
  TlsOption,
} from './connection-types.js';
import { AuthError, CommandError, ConnectionClosedError } from './errors.js';
import { FrameParser } from './frame.js';
import { nowMs, Telemetry } from './observability.js';
import { openSocket } from './socket-factory.js';
import { resolveConnectionTimings } from './validation.js';

export abstract class ConnectionBase extends EventEmitter {
  readonly host: string;
  readonly port: number;
  readonly token: string | undefined;
  readonly tls: TlsOption;
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;

  protected socket: Socket | null = null;
  protected connected = false;
  protected closed = false;
  private connecting: Promise<void> | null = null;
  protected pending = new Map<string, Pending>();
  protected reqCounter = 0;
  private parser = new FrameParser();
  protected connectGeneration = 0;
  private failedAttempts = 0;
  private nextAttemptAt = 0;
  // Half-open recovery: repeated command timeouts force lazy reconnection.
  private readonly maxCommandTimeouts = 3;
  protected consecutiveTimeouts = 0;
  protected readonly telemetry: Telemetry;
  protected readonly backpressure: Backpressure;

  constructor(options: ConnectionOptions = {}) {
    super();
    const timings = resolveConnectionTimings('Connection', options); // throws on a bad value
    this.host = options.host ?? 'localhost';
    this.port = options.port ?? 6789;
    this.token = options.token;
    this.tls = options.tls;
    this.connectTimeoutMs = timings.connectTimeoutMs;
    this.commandTimeoutMs = timings.commandTimeoutMs;
    this.telemetry = new Telemetry(options, (event, payload) => this.emit(event, payload));
    const maxInFlight = timings.maxInFlight;
    this.backpressure = new Backpressure(maxInFlight, () =>
      this.telemetry.backpressure(this.pending.size, maxInFlight)
    );
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Successful-connect generation used to restore per-connection state. */
  get generation(): number {
    return this.connectGeneration;
  }

  /** Open the socket (and authenticate) if not already connected. */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.closed) throw new ConnectionClosedError('connection closed by client');
    // Fast-fail while inside the reconnect backoff window: without this, a
    // producer calling add() against a downed server pays the full connect
    // timeout on EVERY call (reconnect storm).
    if (Date.now() < this.nextAttemptAt) {
      throw new ConnectionClosedError(
        `server unreachable, retry in ${this.nextAttemptAt - Date.now()}ms`
      );
    }
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect()
      .then(() => {
        this.failedAttempts = 0;
        this.nextAttemptAt = 0;
      })
      .catch((err) => {
        this.failedAttempts += 1;
        const backoff = Math.min(500 * 2 ** (this.failedAttempts - 1), 5000);
        this.nextAttemptAt = Date.now() + backoff;
        this.telemetry.reconnectScheduled(this.host, this.port, this.failedAttempts, backoff);
        throw err;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const startMs = nowMs();
    const socket = await this.telemetry.captureAsync(
      'connect',
      openSocket(this.host, this.port, this.tls, this.connectTimeoutMs)
    );
    socket.setNoDelay(true);
    // TCP keepalive surfaces half-open cloud LB/NAT links promptly.
    socket.setKeepAlive(true, 15_000);
    this.parser.clear();
    this.socket = socket;

    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.on('error', (error) => {
      this.telemetry.error('socket', error);
      this.teardown();
    });
    socket.on('close', () => this.teardown());

    this.connected = true;
    this.connectGeneration += 1;
    this.consecutiveTimeouts = 0;
    this.telemetry.connected(this.host, this.port, this.connectGeneration, startMs);

    // INVARIANT (H3): connected is flipped true before Auth, which is safe
    // ONLY because call() writes the Auth frame synchronously — there is no
    // `await` between this line and the Auth socket.write, so no concurrent
    // call() can interleave a frame ahead of Auth on the wire. Do NOT insert
    // an await here or before the Auth call, or a command could race ahead of
    // Auth (the Python SDK guards this with a lock; JS relies on this ordering).
    if (this.token) {
      try {
        await this.call({ cmd: 'Auth', token: this.token });
        this.telemetry.auth(true);
      } catch (err) {
        this.telemetry.auth(false);
        this.teardown();
        if (err instanceof CommandError) throw new AuthError(err.message);
        throw err;
      }
    }
  }

  private handleData(chunk: Buffer): void {
    let frames: Buffer[];
    try {
      frames = this.parser.addData(chunk);
    } catch {
      this.teardown();
      return;
    }
    for (const framePayload of frames) {
      let message: unknown;
      try {
        message = unpack(framePayload);
      } catch {
        continue; // skip unparseable frame; a desynced stream dies via socket error
      }
      if (typeof message !== 'object' || message === null) continue;
      const response = message as Response;
      const reqId = response.reqId;
      if (reqId === undefined || reqId === null) continue; // server-push unsupported
      const entry = this.pending.get(String(reqId));
      if (entry) {
        this.pending.delete(String(reqId));
        this.backpressure.release();
        entry.resolve(response);
      }
    }
  }

  /**
   * A dead/half-open link makes every command time out while the socket still
   * looks connected. After maxCommandTimeouts consecutive timeouts, tear down
   * so the next call() reconnects instead of wedging (mirrors #94).
   */
  protected noteTimeout(gen: number): void {
    // A timeout from an already-replaced connection must not tear down (or
    // miscount against) the current one.
    if (gen !== this.connectGeneration) return;
    this.consecutiveTimeouts += 1;
    if (this.consecutiveTimeouts >= this.maxCommandTimeouts) this.teardown();
  }

  protected teardown(): void {
    const wasConnected = this.socket !== null;
    const gen = this.connectGeneration;
    this.connected = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    const pending = this.pending;
    this.pending = new Map();
    for (const entry of pending.values()) {
      entry.timer.clear();
      entry.reject(new ConnectionClosedError('connection lost'));
    }
    this.backpressure.clear(); // release parked callers; they re-check + fail/reconnect
    if (wasConnected) this.telemetry.disconnected(this.host, this.port, gen);
  }

  /** Send a command and await its response (implemented by Connection). */
  abstract call<R = Response>(command: Command, timeoutMs?: number): Promise<R>;
}
