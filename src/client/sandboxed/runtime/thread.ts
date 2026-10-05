/**
 * Sandbox thread events: readiness and death.
 *
 * A new thread loads its processor module first, then posts `ready`. Until then its
 * slot is `loading` and the pool gives it no job: a message that reaches a thread still
 * loading could be lost. A thread that dies before `ready` (the module failed to load,
 * or exited while loading) is a crash like any other.
 *
 * A thread dies in one of three ways. An uncaught error or an unhandled rejection in
 * the processor raises `error` (then `close`). A `process.exit()` in Bun raises only
 * `close`. bunqueue-client's worker_threads adapter reports both through `onerror`,
 * once. Either way the thread runs nothing more, so its death is reported exactly
 * once through `onDeath`, unless the pool terminated the thread itself (`terminated`
 * set first: recycling, a job timeout, a crash already handled).
 */

import type { IPCResponse, WorkerProcess } from '../types';
import { log } from './log';

/**
 * The longest start() (or a respawn) waits for a thread's `ready` before it counts it as
 * started. A thread still loading after that stays `loading`: it gets jobs once ready.
 */
export const READY_TIMEOUT_MS = 5_000;

/** The events the pool reads from a thread: Bun's Worker or bunqueue-client's adapter. */
export interface ThreadEvents {
  onmessage: ((event: { data: IPCResponse }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
  /** Bun only; the adapter reports an exit through `onerror` instead. */
  addEventListener?: (type: 'close', listener: (event: { code?: number }) => void) => void;
}

export interface ThreadHandlers {
  workerIndex: number;
  onMessage(message: IPCResponse): void;
  /** The thread died on its own; `reason` describes how. */
  onDeath(reason: string): void;
}

/**
 * Wire a new thread's events; `slot.loading` must be set. Resolves once it posts
 * `ready` (or after READY_TIMEOUT_MS); rejects when it dies first, so a processor
 * module that fails to load fails start(). `ready` clears `slot.loading` whenever it
 * comes, after the timeout too.
 */
export function watchThread(
  thread: ThreadEvents,
  slot: WorkerProcess,
  handlers: ThreadHandlers
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const readyTimeout = setTimeout(() => settle(), READY_TIMEOUT_MS);
    function settle(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(readyTimeout);
      if (error) reject(error);
      else resolve();
    }
    function died(reason: string): void {
      settle(new Error(reason));
      if (!slot.terminated) handlers.onDeath(reason);
    }

    thread.onmessage = (event) => {
      if (event.data.type === 'ready') {
        slot.loading = false;
        settle();
        return;
      }
      handlers.onMessage(event.data);
    };
    thread.onerror = (error) => {
      log('error', 'Worker error', { workerIndex: handlers.workerIndex, error: error.message });
      died(error.message || 'uncaught error in the processor');
    };
    thread.addEventListener?.('close', (event) => {
      died(`thread exited with code ${event.code ?? 'unknown'}`);
    });
  });
}
