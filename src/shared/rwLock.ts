/** Writer-priority read/write lock with FIFO writer handoff. */

import {
  LockTimeoutError,
  READ_LOCK_TIMEOUT_MESSAGE,
  WRITE_LOCK_TIMEOUT_MESSAGE,
} from './lockError';
import { lockTimeoutMs } from './lockTimeout';
import { safeTimeout, type SafeTimer } from './timers';
import type { LockGuard } from './types/lock';

interface RWWaiter {
  resolve: (guard: LockGuard) => void;
  reject: (error: LockTimeoutError) => void;
  timer?: SafeTimer;
  settled: boolean;
}

export class RWLock {
  private readers = 0;
  private writer = false;
  private writerWaiting = 0;
  private readonly readerQueue: RWWaiter[] = [];
  private readonly writerQueue: RWWaiter[] = [];

  /**
   * Acquire a shared read guard. `timeoutMs` defaults to LOCK_TIMEOUT_MS; a value <= 0
   * rejects at once when contended, and any longer value is honoured (`safeTimeout`).
   */
  acquireRead(timeoutMs?: number): Promise<LockGuard> {
    if (!this.writer && this.writerWaiting === 0) {
      this.readers++;
      return Promise.resolve(this.createReadGuard());
    }

    return new Promise<LockGuard>((resolve, reject) => {
      const waitMs = timeoutMs ?? lockTimeoutMs();
      if (waitMs <= 0) {
        reject(new LockTimeoutError(READ_LOCK_TIMEOUT_MESSAGE));
        return;
      }
      const waiter = this.createWaiter(resolve, reject, waitMs, () => {
        waiter.reject(new LockTimeoutError(READ_LOCK_TIMEOUT_MESSAGE));
        this.drain();
      });
      this.readerQueue.push(waiter);
    });
  }

  /** Acquire the exclusive write guard; `timeoutMs` as for `acquireRead`. */
  acquireWrite(timeoutMs?: number): Promise<LockGuard> {
    if (!this.writer && this.readers === 0 && this.writerWaiting === 0) {
      this.writer = true;
      return Promise.resolve(this.createWriteGuard());
    }

    return new Promise<LockGuard>((resolve, reject) => {
      const waitMs = timeoutMs ?? lockTimeoutMs();
      if (waitMs <= 0) {
        reject(new LockTimeoutError(WRITE_LOCK_TIMEOUT_MESSAGE));
        return;
      }
      const waiter = this.createWaiter(resolve, reject, waitMs, () => {
        this.writerWaiting--;
        waiter.reject(new LockTimeoutError(WRITE_LOCK_TIMEOUT_MESSAGE));
        this.drain();
      });
      this.writerWaiting++;
      this.writerQueue.push(waiter);
      this.drain();
    });
  }

  getState(): { readers: number; writer: boolean; writerWaiting: number } {
    return { readers: this.readers, writer: this.writer, writerWaiting: this.writerWaiting };
  }

  private createWaiter(
    resolve: (guard: LockGuard) => void,
    reject: (error: LockTimeoutError) => void,
    timeoutMs: number,
    onTimeout: () => void
  ): RWWaiter {
    const waiter: RWWaiter = {
      resolve,
      reject,
      settled: false,
    };
    waiter.timer = safeTimeout(() => {
      if (waiter.settled) return;
      waiter.settled = true;
      onTimeout();
    }, timeoutMs);
    return waiter;
  }

  private drain(): void {
    if (this.writer) return;
    if (this.writerWaiting > 0) {
      if (this.readers > 0) return;
      const waiter = this.takeWriter();
      if (waiter) {
        waiter.settled = true;
        waiter.timer?.clear();
        this.writerWaiting--;
        this.writer = true;
        waiter.resolve(this.createWriteGuard());
        return;
      }
      this.writerWaiting = 0;
    }
    this.grantReaders();
  }

  private takeWriter(): RWWaiter | undefined {
    let waiter = this.writerQueue.shift();
    while (waiter?.settled) waiter = this.writerQueue.shift();
    return waiter;
  }

  private grantReaders(): void {
    const waiters = this.readerQueue.splice(0);
    for (const waiter of waiters) {
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.timer?.clear();
      this.readers++;
      waiter.resolve(this.createReadGuard());
    }
  }

  private createReadGuard(): LockGuard {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.readers--;
        this.drain();
      },
    };
  }

  private createWriteGuard(): LockGuard {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.writer = false;
        this.drain();
      },
    };
  }
}
