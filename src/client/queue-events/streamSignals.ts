/**
 * Internal lifecycle signals of a QueueEvents stream, for job waits.
 *
 * They are not QueueEvents events: listeners of the public API never see them, and
 * `close()` removing every listener cannot drop them.
 * - `resubscribed`: a TCP stream subscribed again after a lost connection; events
 *   sent while it was disconnected are gone, so a wait re-reads its job.
 * - `closed`: the stream delivers no more events; a wait continues without it.
 */

export type EventStreamSignal = 'resubscribed' | 'closed';

type SignalListener = (signal: EventStreamSignal) => void;

const listenersByStream = new WeakMap<object, Set<SignalListener>>();

/** Listen to the signals of `stream`; returns the unsubscribe function. */
export function watchEventStream(stream: object, listener: SignalListener): () => void {
  let listeners = listenersByStream.get(stream);
  if (!listeners) {
    listeners = new Set();
    listenersByStream.set(stream, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = listenersByStream.get(stream);
    current?.delete(listener);
    if (current?.size === 0) listenersByStream.delete(stream);
  };
}

/** Deliver `signal` to the listeners of `stream`; `closed` also drops them. */
export function signalEventStream(stream: object, signal: EventStreamSignal): void {
  const listeners = listenersByStream.get(stream);
  if (!listeners) return;
  if (signal === 'closed') listenersByStream.delete(stream);
  for (const listener of [...listeners]) {
    try {
      listener(signal);
    } catch {
      // One failing listener must not keep the others from the signal.
    }
  }
}
