/**
 * TCP Reconnection Manager
 * Handles automatic reconnection with exponential backoff
 */

import { EventEmitter } from 'events';
import { safeTimeout, type SafeTimer } from '../../shared/timers';

/** Reconnection configuration */
export interface ReconnectConfig {
  maxReconnectAttempts: number;
  reconnectDelay: number;
  maxReconnectDelay: number;
  autoReconnect: boolean;
}

/** 2^1023 is the largest finite power of two; the delay is at its ceiling long before. */
const MAX_BACKOFF_EXPONENT = 1023;

/**
 * min(reconnectDelay * 2^(attempt - 1), maxReconnectDelay) plus up to 30% jitter, finite
 * for any attempt: with the exponent capped the factor stays finite, so a 0 base can
 * no longer make 0 * Infinity (NaN), an overflowing product is capped by the ceiling,
 * and the jittered sum is capped at Number.MAX_VALUE. An infinite `reconnectDelay`
 * waits `maxReconnectDelay` every time and an infinite ceiling leaves the growth
 * uncapped, as on 2.9.10 (whose timer then fired after ~1 ms instead).
 */
function backoffDelay(attempt: number, reconnectDelay: number, maxReconnectDelay: number): number {
  const exponent = Math.min(attempt - 1, MAX_BACKOFF_EXPONENT);
  const baseDelay = Math.min(reconnectDelay * 2 ** exponent, maxReconnectDelay);
  return Math.min(baseDelay + Math.random() * 0.3 * baseDelay, Number.MAX_VALUE);
}

/**
 * Manages reconnection attempts with exponential backoff
 */
export class ReconnectManager extends EventEmitter {
  // ============ Typed Event Overloads ============

  on(event: 'maxReconnectAttemptsReached', listener: () => void): this;
  on(event: 'reconnecting', listener: (data: { attempt: number; delay: number }) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  once(event: 'maxReconnectAttemptsReached', listener: () => void): this;
  once(event: 'reconnecting', listener: (data: { attempt: number; delay: number }) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  once(event: string, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  private reconnectAttempts = 0;
  private reconnectTimer: SafeTimer | null = null;
  private closed = false;

  constructor(private readonly config: ReconnectConfig) {
    super();
  }

  /** Mark as closed (prevents further reconnects) */
  setClosed(closed: boolean): void {
    this.closed = closed;
    if (closed) {
      this.cancelReconnect();
    }
  }

  /** Check if closed */
  isClosed(): boolean {
    return this.closed;
  }

  /** Reset reconnect attempts (call on successful connect) */
  reset(): void {
    this.reconnectAttempts = 0;
  }

  /** Cancel pending reconnection */
  cancelReconnect(): void {
    if (this.reconnectTimer) {
      this.reconnectTimer.clear();
      this.reconnectTimer = null;
    }
  }

  /** Check if reconnection is allowed */
  canReconnect(): boolean {
    return this.config.autoReconnect && !this.closed;
  }

  /**
   * Schedule reconnection with exponential backoff. Returns false if max attempts were
   * reached, a reconnect is already pending, or the manager is (or got) closed.
   */
  scheduleReconnect(connectFn: () => Promise<void>): boolean {
    if (this.reconnectTimer || this.closed) return false;

    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.config.maxReconnectAttempts) {
      this.emit('maxReconnectAttemptsReached');
      return false;
    }

    // Exponential backoff with jitter
    const delay = backoffDelay(
      this.reconnectAttempts,
      this.config.reconnectDelay,
      this.config.maxReconnectDelay
    );

    // Armed before 'reconnecting' is emitted, so a listener that closes the client
    // (setClosed(true) -> cancelReconnect) cancels this retry instead of racing it.
    // safeTimeout honours a delay above 2^31 - 1 ms instead of firing after ~1 ms.
    const timer = safeTimeout(() => {
      if (this.reconnectTimer !== timer) return;
      this.reconnectTimer = null;
      if (this.closed) return;
      connectFn().catch(() => {
        // connect() will schedule another reconnect if needed
      });
    }, delay);
    this.reconnectTimer = timer;

    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    return this.reconnectTimer === timer;
  }
}
