/**
 * Bunqueue — Circuit Breaker for worker protection
 *
 * The reset timer is a `safeTimeout`: a `resetTimeout` longer than the runtime's timer
 * limit (about 24.8 days) half-opens when it elapses instead of after about 1 ms, and
 * `resetTimeout: Infinity` arms nothing, so the circuit stays open until reset().
 */

import { safeTimeout, type SafeTimer } from '../../shared/timers';
import type { Worker } from '../worker/worker';
import type { CircuitBreakerConfig, CircuitState } from './types';

export class WorkerCircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private timer: SafeTimer | null = null;
  private destroyed = false;
  private readonly config: CircuitBreakerConfig;
  private readonly worker: Worker;
  /** Validated by the Bunqueue constructor and read once. */
  private readonly threshold: number;
  private readonly resetTimeoutMs: number;

  constructor(config: CircuitBreakerConfig, worker: Worker) {
    this.config = config;
    this.worker = worker;
    this.threshold = config.threshold ?? 5;
    this.resetTimeoutMs = config.resetTimeout ?? 30000;
  }

  get currentState(): CircuitState {
    return this.state;
  }

  isOpen(): boolean {
    return this.state === 'open';
  }

  onSuccess(): void {
    if (this.destroyed) return;
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.failures = 0;
      this.config.onClose?.();
    } else if (this.state === 'closed') {
      this.failures = 0;
    }
  }

  onFailure(): void {
    if (this.destroyed) return;
    this.failures++;

    if (this.state === 'half-open' || this.failures >= this.threshold) {
      this.open();
    }
  }

  private open(): void {
    if (this.destroyed) return;
    this.state = 'open';
    this.config.onOpen?.(this.failures);
    if (this.destroyed) return;
    this.worker.pause();

    this.timer?.clear();
    const timer = safeTimeout(() => {
      if (this.destroyed || this.timer !== timer) return;
      this.timer = null;
      this.state = 'half-open';
      this.config.onHalfOpen?.();
      if (this.destroyed) return;
      this.worker.resume();
    }, this.resetTimeoutMs);
    this.timer = timer;
  }

  reset(): void {
    if (this.destroyed) return;
    this.state = 'closed';
    this.failures = 0;
    if (this.timer) {
      this.timer.clear();
      this.timer = null;
    }
    if (this.worker.isPaused()) {
      this.worker.resume();
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) {
      this.timer.clear();
      this.timer = null;
    }
  }
}
