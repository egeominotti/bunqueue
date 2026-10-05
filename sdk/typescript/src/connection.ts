/** Cross-runtime TCP connection with reqId-based request pipelining. */

import { ConnectionBase } from './connection-base.js';
import type { Command, Response } from './connection-types.js';
import { CommandError, CommandTimeoutError, ConnectionClosedError } from './errors.js';
import { PROTOCOL_VERSION } from './frame.js';
import { nowMs } from './observability.js';
import { serializeCommand } from './serialization.js';
import { safeTimeout } from './timing.js';
import { commandDeadline } from './validation.js';

export type { Command, ConnectionOptions, Response, TlsOption } from './connection-types.js';

/**
 * A pipelined connection with lifecycle events and an optional structured
 * telemetry sink.
 */
export class Connection extends ConnectionBase {
  /**
   * Send a command and await its response. Rejects with CommandError when
   * the server answers ok=false. Reconnects lazily if the link was lost.
   * `timeoutMs` (>= 1 ms, any length honoured; Infinity = none) overrides commandTimeoutMs.
   */
  override async call<R = Response>(command: Command, timeoutMs?: number): Promise<R> {
    const deadlineMs = commandDeadline(timeoutMs, this.commandTimeoutMs);
    if (!this.connected) await this.connect();
    this.reqCounter = (this.reqCounter + 1) & 0x7fffffff;
    const reqId = String(this.reqCounter);
    const outbound = this.telemetry.capture('serialization', () =>
      serializeCommand(command, reqId)
    );
    // Backpressure: park here if too many commands are already in flight. The
    // socket may be torn down while parked, so re-check after the gate.
    const gate = this.backpressure.acquire(this.pending.size);
    if (gate) await gate;
    const socket = this.socket;
    if (!this.connected || !socket) throw new ConnectionClosedError('not connected');

    const gen = this.connectGeneration; // snapshot: a timeout must not tear down a newer conn
    const startMs = nowMs();

    return new Promise<R>((resolve, reject) => {
      const timer = safeTimeout(() => {
        this.pending.delete(reqId);
        this.backpressure.release();
        this.telemetry.timeout(command.cmd, reqId);
        this.noteTimeout(gen);
        reject(new CommandTimeoutError(`no response for ${command.cmd} within timeout`));
      }, deadlineMs);

      this.pending.set(reqId, {
        resolve: (response) => {
          timer.clear();
          this.consecutiveTimeouts = 0; // any reply means the link is alive
          this.telemetry.command(command.cmd, reqId, startMs, response.ok);
          if (!response.ok) {
            reject(new CommandError(String(response.error ?? 'unknown server error')));
          } else {
            resolve(response as R);
          }
        },
        reject: (err) => {
          timer.clear();
          reject(err);
        },
        timer,
      });

      socket.write(outbound, (err) => {
        if (err) {
          this.telemetry.error('write', err);
          const entry = this.pending.get(reqId);
          this.pending.delete(reqId);
          this.backpressure.release();
          entry?.reject(new ConnectionClosedError(`send failed: ${err.message}`));
          this.teardown();
        }
      });
    });
  }

  /** Ping the server; returns true when it answers pong. */
  async ping(): Promise<boolean> {
    try {
      const response = await this.call({ cmd: 'Ping' });
      const data = response.data as Record<string, unknown> | undefined;
      return data?.pong === true;
    } catch {
      return false;
    }
  }

  /** Protocol negotiation; returns server name/version/protocolVersion. */
  hello(): Promise<Response> {
    return this.call({
      cmd: 'Hello',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: ['pipelining', 'separate-job-name'],
    });
  }

  /** Close permanently; in-flight commands reject. */
  close(): void {
    this.closed = true;
    this.teardown();
  }
}
