/**
 * Shared listeners of one QueueEvents (or any emitter of its payloads) for every
 * job wait on it.
 *
 * The listeners are attached by the first wait, dispatch by job id, and are removed
 * with the last wait, so N waits add no per-wait listener (and no O(N) dispatch or
 * MaxListenersExceededWarning). Besides the outcome events, `stalled` and `removed`
 * are hints to re-read the job, and so is a QueueEvents re-subscribing after a lost
 * connection; `close()` tells every wait to continue without the emitter.
 */

import { watchEventStream } from '../queue-events/streamSignals';

export interface FinishEventData {
  jobId: string;
  returnvalue?: unknown;
  failedReason?: string;
  terminal?: boolean;
}

/** Payloads come from user-supplied emitters too, so a missing one is tolerated. */
type FinishListener = (data: FinishEventData | undefined) => void;

/** The part of QueueEvents a wait uses. */
export interface FinishEvents {
  on(event: string, listener: FinishListener): unknown;
  off(event: string, listener: FinishListener): unknown;
  waitUntilReady?(): Promise<unknown>;
}

export interface EmitterJobWatcher {
  completed(value: unknown): void;
  /** A terminal failure; a failed attempt that will be retried is not reported. */
  failed(reason: string): void;
  /** Something happened to the job: re-read it. */
  hint(): void;
  /** Events may have been lost (the stream re-subscribed): re-read within the budget. */
  lost(): void;
  /** The emitter delivers no more events. */
  closed(): void;
}

interface Dispatch {
  readonly watchers: Map<string, Set<EmitterJobWatcher>>;
  readonly attached: Array<[string, FinishListener]>;
  stopSignals: () => void;
  /** One readiness round trip for every wait of this dispatch. */
  ready?: Promise<unknown>;
}

const dispatches = new WeakMap<FinishEvents, Dispatch>();

export function isFinishEvents(value: unknown): value is FinishEvents {
  const events = value as Partial<FinishEvents> | null | undefined;
  return typeof events?.on === 'function' && typeof events.off === 'function';
}

/** Deliver the events of job `id` on `events` to `watcher`; returns the unsubscribe. */
export function watchEmitterJob(
  events: FinishEvents,
  id: string,
  watcher: EmitterJobWatcher
): () => void {
  const existing = dispatches.get(events);
  const dispatch = existing ?? open(events);
  let forJob = dispatch.watchers.get(id);
  if (!forJob) {
    forJob = new Set();
    dispatch.watchers.set(id, forJob);
  }
  forJob.add(watcher);
  // Attached once the watcher is registered: an emitter may report while subscribing.
  if (!existing) attach(events, dispatch);
  return () => {
    const current = dispatch.watchers.get(id);
    if (!current?.delete(watcher)) return;
    if (current.size === 0) dispatch.watchers.delete(id);
    if (dispatch.watchers.size === 0) close(events, dispatch);
  };
}

/**
 * Resolves once `events` delivers events. A TCP QueueEvents answers with a Ping on
 * its own connection, so the waits of one dispatch share a single round trip; a
 * failed one is retried by the next wait. A wait joining later reads at once: events
 * lost to a disconnection meanwhile are covered by the `resubscribed` re-read.
 */
export function emitterReady(events: FinishEvents): Promise<unknown> {
  const dispatch = dispatches.get(events);
  const ready = () => Promise.resolve().then(() => events.waitUntilReady?.());
  if (!dispatch) return ready();
  dispatch.ready ??= ready().catch((error: unknown) => {
    if (dispatches.get(events) === dispatch) dispatch.ready = undefined;
    throw error;
  });
  return dispatch.ready;
}

function open(events: FinishEvents): Dispatch {
  const dispatch: Dispatch = { watchers: new Map(), attached: [], stopSignals: () => undefined };
  dispatches.set(events, dispatch);
  dispatch.stopSignals = watchEventStream(events, (signal) => {
    const all = [...dispatch.watchers.values()].flatMap((forJob) => [...forJob]);
    if (signal === 'resubscribed') {
      for (const watcher of all) watcher.lost();
      return;
    }
    close(events, dispatch);
    dispatch.watchers.clear();
    for (const watcher of all) watcher.closed();
  });
  return dispatch;
}

function attach(events: FinishEvents, dispatch: Dispatch): void {
  type Notify = (watcher: EmitterJobWatcher, data: FinishEventData) => void;
  const each = (data: FinishEventData | undefined, notify: Notify) => {
    if (!data) return;
    const forJob = dispatch.watchers.get(data.jobId);
    if (forJob) for (const watcher of forJob) notify(watcher, data);
  };
  const listeners: Array<[string, FinishListener]> = [
    ['completed', (data) => each(data, (watcher, d) => watcher.completed(d.returnvalue))],
    [
      'failed',
      // A failed attempt that will be retried is not the job's outcome.
      (data) => {
        if (data?.terminal === false) return;
        each(data, (watcher, d) => watcher.failed(d.failedReason ?? 'Job failed'));
      },
    ],
    ['stalled', (data) => each(data, (watcher) => watcher.hint())],
    ['removed', (data) => each(data, (watcher) => watcher.hint())],
  ];
  for (const entry of listeners) {
    if (dispatches.get(events) !== dispatch) break;
    try {
      events.on(entry[0], entry[1]);
      dispatch.attached.push(entry);
    } catch {
      // An emitter that refuses an event name only loses that hint: state reads and
      // the safety net still settle the wait.
    }
  }
  // The last wait settled while the listeners were being attached.
  if (dispatches.get(events) !== dispatch) release(events, dispatch);
}

function close(events: FinishEvents, dispatch: Dispatch): void {
  if (dispatches.get(events) !== dispatch) return;
  dispatches.delete(events);
  release(events, dispatch);
}

function release(events: FinishEvents, dispatch: Dispatch): void {
  dispatch.stopSignals();
  for (const [name, listener] of dispatch.attached.splice(0)) {
    try {
      events.off(name, listener);
    } catch {
      // Best effort: the remaining listeners must still be removed.
    }
  }
}
