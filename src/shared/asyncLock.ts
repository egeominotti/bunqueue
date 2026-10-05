/** FIFO asynchronous mutex with direct ownership handoff. */

import { LockTimeoutError } from './lockError';
import { lockTimeoutMs } from './lockTimeout';
import { safeTimeout, type SafeTimer } from './timers';
import type { LockGuard } from './types/lock';

interface AsyncWaiter {
  resolve: (guard: LockGuard) => void;
  reject: (error: LockTimeoutError) => void;
  timer?: SafeTimer;
  settled: boolean;
}

export class AsyncLock {
  private locked = false;
  private readonly queue: AsyncWaiter[] = [];

  /**
   * Acquire the lock. `timeoutMs` defaults to LOCK_TIMEOUT_MS; a value <= 0 rejects at
   * once when the lock is contended, and any longer value is honoured (`safeTimeout`).
   */
  acquire(timeoutMs?: number): Promise<LockGuard> {
    if (!this.locked && this.queue.length === 0) {
      this.locked = true;
      return Promise.resolve(this.createGuard());
    }

    return new Promise<LockGuard>((resolve, reject) => {
      const waitMs = timeoutMs ?? lockTimeoutMs();
      if (waitMs <= 0) {
        reject(new LockTimeoutError());
        return;
      }
      const waiter: AsyncWaiter = {
        resolve,
        reject,
        settled: false,
      };
      waiter.timer = safeTimeout(() => this.timeout(waiter), waitMs);
      this.queue.push(waiter);
      this.drain();
    });
  }

  isLocked(): boolean {
    return this.locked;
  }

  /** Queue size includes lazily pruned timed-out entries. */
  getQueueLength(): number {
    return this.queue.length;
  }

  private timeout(waiter: AsyncWaiter): void {
    if (waiter.settled) return;
    waiter.settled = true;
    waiter.reject(new LockTimeoutError());
    this.drain();
  }

  private drain(): void {
    if (this.locked) return;
    let waiter = this.queue.shift();
    while (waiter?.settled) waiter = this.queue.shift();
    if (!waiter) return;

    waiter.settled = true;
    waiter.timer?.clear();
    this.locked = true;
    waiter.resolve(this.createGuard());
  }

  private createGuard(): LockGuard {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.locked = false;
        this.drain();
      },
    };
  }
}
