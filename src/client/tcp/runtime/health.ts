import { decodeMessagePack } from '../../../shared/msgpack';
import type { JobEvent } from '../../../domain/types/queue';
import type { SendOptions } from '../types';
import { TcpClientConnectivity } from './connectivity';

function isJobEvent(value: unknown): value is JobEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.eventType === 'string' &&
    typeof event.queue === 'string' &&
    typeof event.jobId === 'string' &&
    typeof event.timestamp === 'number' &&
    Number.isFinite(event.timestamp)
  );
}

/** Response dispatch, health tracking, and reconnect decisions. */
export abstract class TcpClientHealth extends TcpClientConnectivity {
  protected handleData(frame: Uint8Array): void {
    try {
      const response = decodeMessagePack<Record<string, unknown>>(frame);
      if (response.type === 'event') {
        if (!isJobEvent(response.event)) throw new Error('Invalid queue event frame');
        this.emit('queueEvent', response.event);
        return;
      }
      const reqId = response.reqId as string | undefined;

      if (reqId) {
        const pending = this.commands.removeByReqId(reqId);
        if (pending) {
          pending.timeout.clear();
          pending.resolve(response);
          this.processQueue();
          return;
        }
      }

      const current = this.commands.getCurrentCommand();
      if (current) {
        current.timeout.clear();
        current.resolve(response);
        this.commands.setCurrentCommand(null);
        this.processQueue();
        return;
      }

      this.emit('warning', { type: 'unknown_response', reqId });
    } catch {
      const error = new Error('Invalid response from server');
      this.emit('warning', { type: 'malformed_frame' });
      this.commands.rejectAll(error);
      this.forceReconnect();
    }
  }

  /**
   * The current socket closed (events of a retired socket never get here). An attempt
   * in flight owns `connecting`: it fails on its own and resets it, or schedules the
   * retry, so a close during an attempt only clears the socket and its commands.
   */
  protected handleClose(): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = null;
    this.health.stopPing();
    this.commands.rejectAll(new Error('Connection lost'));

    if (wasConnected) {
      this.emit('disconnected');
      if (this.reconnect.canReconnect()) {
        this.reconnect.scheduleReconnect(() => this.connect());
      }
    }
  }

  async ping(): Promise<boolean> {
    if (!this.connected) return false;
    try {
      const start = Date.now();
      const response = await this.send({ cmd: 'Ping' });
      const data = response.data as Record<string, unknown> | undefined;
      const success = data?.pong === true;

      if (success) {
        this.health.recordPingSuccess(Date.now() - start);
        this.emit('health', { type: 'ping_success', latency: Date.now() - start });
      } else {
        this.handlePingFailure();
      }
      return success;
    } catch {
      this.handlePingFailure();
      return false;
    }
  }

  protected abstract send(
    command: Record<string, unknown>,
    options?: SendOptions
  ): Promise<Record<string, unknown>>;

  private handlePingFailure(): void {
    if (this.health.recordPingFailure()) {
      this.emit('health', { type: 'unhealthy', reason: 'max_ping_failures' });
      this.forceReconnect();
    } else {
      this.emit('health', { type: 'ping_failed' });
    }
  }

  protected handleCommandTimeout(): void {
    if (this.health.recordCommandTimeout()) {
      this.emit('health', { type: 'unhealthy', reason: 'max_command_timeouts' });
      this.forceReconnect();
    }
  }

  private forceReconnect(): void {
    if (this.reconnect.isClosed()) return;
    // Retire the socket (and an attempt in flight): its close, when it comes, must not
    // run the lost-connection path again against the connection that replaces it.
    this.generation++;
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    if (socket) {
      try {
        socket.end();
      } catch {
        // Socket already torn down.
      }
    }
    this.health.stopPing();
    this.commands.rejectAll(new Error('Connection lost'));
    if (this.reconnect.canReconnect()) this.reconnect.scheduleReconnect(() => this.connect());
  }

  getHealth() {
    return this.health.getHealth(this.getState());
  }

  protected abstract getState(): 'connected' | 'connecting' | 'disconnected' | 'closed';

  protected generateReqId(): string {
    this.reqIdCounter = (this.reqIdCounter + 1) & 0x7fffffff;
    return String(this.reqIdCounter);
  }
}
