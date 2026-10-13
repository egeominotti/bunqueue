/**
 * Completion waiters: event-driven waits for one job's completion (WaitJob, the MCP
 * wait tool). The registry is owned by EventsManager, which releases a job's waiters
 * when it broadcasts that job's `completed` event, and every waiter at shutdown.
 */

import type { JobId } from '../domain/types/job';
import type { JobEvent } from '../domain/types/queue';
import { assertDuration } from '../shared/durations';
import { safeTimeout } from '../shared/timers';

/** Accepted completion-wait timeouts: finite ms >= 0, any length (`safeTimeout`). */
const WAIT_TIMEOUT_LIMITS = { min: 0 } as const;

/**
 * How a completion wait ended. A waiter woken by the job's `completed` event carries
 * that event's data, the job's return value, so a job removed on completion (which
 * keeps no result) still answers with it. One released without an event (the manager
 * shut down) has no result to carry.
 */
export type CompletionWaitOutcome =
  | { readonly completed: false }
  | { readonly completed: true; readonly fromEvent: true; readonly result: unknown }
  | { readonly completed: true; readonly fromEvent: false };

/** Waiter entry with cancellation flag for O(1) cleanup */
export interface CompletionWaiter {
  /** `event` is the `completed` event that woke the waiter; absent at shutdown. */
  resolve: (event?: JobEvent) => void;
  cancel: () => void;
  cancelled: boolean;
}

/** Waiters keyed by `String(jobId)`. */
export type CompletionWaiterRegistry = Map<string, Set<CompletionWaiter>>;

/** Maps how a waiter was released to the outcome `waitForJobOutcome` resolves with. */
export function completionOutcome(completed: boolean, event?: JobEvent): CompletionWaitOutcome {
  if (!completed) return { completed: false };
  return event
    ? { completed: true, fromEvent: true, result: event.data }
    : { completed: true, fromEvent: false };
}

/** One completion wait: the job, its timeout, an optional abort signal. */
export interface CompletionWaitRequest {
  readonly jobId: JobId;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** The public method named in the timeout validation error. */
  readonly caller: string;
}

/**
 * Register a waiter for `jobId` in `registry` and resolve with `settle(completed, event)`
 * once it is released (completed), times out or is aborted (not completed). `timeoutMs`
 * must be a finite number >= 0 (0 times out on the next tick; longer than 2^31 - 1 ms
 * is honoured); anything else throws a TypeError/RangeError synchronously, naming
 * `caller`, before a waiter exists. The waiter leaves the registry however it settles.
 */
export function awaitCompletion<T>(
  registry: CompletionWaiterRegistry,
  request: CompletionWaitRequest,
  settle: (completed: boolean, event?: JobEvent) => T
): Promise<T> {
  const { jobId, timeoutMs, signal, caller } = request;
  assertDuration(timeoutMs, `${caller}: timeoutMs`, WAIT_TIMEOUT_LIMITS);
  const jobKey = String(jobId);
  if (signal?.aborted) return Promise.resolve(settle(false));

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      timer.clear();
      signal?.removeEventListener('abort', onAbort);
      const waiters = registry.get(jobKey);
      waiters?.delete(waiter);
      if (waiters?.size === 0) registry.delete(jobKey);
    };
    const finish = (completed: boolean, event?: JobEvent) => {
      if (settled) return;
      settled = true;
      waiter.cancelled = !completed;
      cleanup();
      resolve(settle(completed, event));
    };
    const onAbort = () => finish(false);
    const waiter: CompletionWaiter = {
      resolve: (event) => finish(true, event),
      cancel: () => finish(false),
      cancelled: false,
    };

    let waiters = registry.get(jobKey);
    if (!waiters) {
      waiters = new Set();
      registry.set(jobKey, waiters);
    }
    waiters.add(waiter);
    const timer = safeTimeout(() => finish(false), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
