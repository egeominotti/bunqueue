/**
 * Job wait (BullMQ v5 compatible)
 *
 * The one implementation behind `Queue.waitJobUntilFinished` and every
 * `job.waitUntilFinished`, embedded and TCP. A wait settles on the job's final
 * outcome: its result once it completes, or its last failure once no retry is
 * left. A failed attempt that will be retried (a `failed` event with
 * `terminal: false`) does not settle it. A job that no longer exists settles it
 * with `Job <id> not found`.
 *
 * Embedded: the job's events from the shared manager (one subscription per
 * manager, `job-wait/managerDispatch.ts`), state reads that never create a
 * manager, and a rejection when shutdownManager() stops the engine.
 * TCP with QueueEvents: its events (`job-wait/emitterDispatch.ts`) and state
 * reads; without it, or once it closes, capped WaitJob holds and scheduled reads
 * (`job-wait/brokerWait.ts`). Both re-read the job on hints and on a jittered
 * safety-net schedule within a per-connection budget (`job-wait/readScheduler.ts`).
 * Only the first read is fatal on any error; a later read that fails transiently
 * (rate limit, timeout, lost connection) is retried (`job-wait/session.ts`).
 */

import { EventType, type JobEvent } from '../domain/types/queue';
import { peekSharedManager } from './manager';
import { waitThroughBroker } from './job-wait/brokerWait';
import {
  emitterReady,
  isFinishEvents,
  watchEmitterJob,
  type EmitterJobWatcher,
  type FinishEvents,
} from './job-wait/emitterDispatch';
import { watchManagerJob } from './job-wait/managerDispatch';
import {
  EMBEDDED_READS_PER_SECOND,
  readSchedulerFor,
  SAFETY_NET,
  TCP_READS_PER_SECOND,
} from './job-wait/readScheduler';
import { brokerReader, managerReader } from './job-wait/readers';
import { JobWaitSession } from './job-wait/session';
import {
  ENGINE_SHUT_DOWN,
  type CommandTransport,
  type Outcome,
  type WaitLimit,
} from './job-wait/types';

/** Runtime a wait reads from: the shared embedded manager or a TCP connection. */
export interface JobWaitContext {
  embedded?: boolean;
  tcp?: CommandTransport | null;
}

/** Without QueueEvents an omitted TTL is 30 s, as the broker's WaitJob default. */
const DEFAULT_TTL_MS = 30_000;

/**
 * Wait for a job's final outcome. A TTL that is not a positive number (0, a
 * negative number, NaN, Infinity) means no timeout, with or without QueueEvents.
 * An omitted TTL means no timeout with QueueEvents (BullMQ) and 30 s without.
 */
export function waitJobUntilFinished(
  ctx: JobWaitContext,
  id: string,
  queueEvents: unknown,
  ttl?: number | null
): Promise<unknown> {
  const events = isFinishEvents(queueEvents) ? queueEvents : null;
  const limit = waitLimit(id, ttl, events !== null);
  if (ctx.embedded) return waitEmbedded(id, events, limit);
  if (ctx.tcp) return waitOverTcp(ctx.tcp, id, events, limit);
  return Promise.reject(new Error('waitUntilFinished: no connection'));
}

function waitLimit(id: string, ttl: number | null | undefined, withEvents: boolean): WaitLimit {
  const ms = ttl ?? (withEvents ? undefined : DEFAULT_TTL_MS);
  const bounded = typeof ms === 'number' && Number.isFinite(ms) && ms > 0;
  return {
    deadline: bounded ? Date.now() + ms : Number.POSITIVE_INFINITY,
    message: withEvents
      ? `Job ${id} timed out after ${ms}ms`
      : `waitUntilFinished timed out after ${ms}ms`,
  };
}

function settleWith(resolve: (value: unknown) => void, reject: (error: Error) => void) {
  return (outcome: Outcome) => {
    if ('error' in outcome) reject(outcome.error);
    else resolve(outcome.value);
  };
}

function emitterWatcher(session: JobWaitSession, onClosed: () => void): EmitterJobWatcher {
  return {
    completed: (value) => session.settle({ value }),
    failed: (reason) => session.settle({ error: new Error(reason) }),
    hint: () => session.recheck(),
    lost: () => session.recheckSoon(),
    closed: onClosed,
  };
}

function onManagerEvent(session: JobWaitSession, event: JobEvent): void {
  if (event.eventType === EventType.Completed) {
    session.settle({ value: event.data });
  } else if (event.eventType === EventType.Failed) {
    // A failed attempt that will be retried is not the job's outcome.
    if (event.terminal !== false) session.settle({ error: new Error(event.error ?? 'Job failed') });
  } else if (event.eventType === EventType.Stalled || event.eventType === EventType.Removed) {
    // A stall can move the job to the DLQ with no `failed` event; a removal ends it.
    session.recheck();
  }
}

/** Embedded: the manager's events for the job are authoritative and synchronous. */
function waitEmbedded(id: string, events: FinishEvents | null, limit: WaitLimit) {
  // Never getSharedManager(): after shutdownManager() it would start a new engine.
  const manager = peekSharedManager();
  if (!manager) return Promise.reject(new Error(ENGINE_SHUT_DOWN));
  return new Promise<unknown>((resolve, reject) => {
    const session = new JobWaitSession({
      reader: managerReader(manager, id),
      finish: settleWith(resolve, reject),
      scheduler: readSchedulerFor(manager, EMBEDDED_READS_PER_SECOND),
    });
    session.onSettle(
      watchManagerJob(manager, id, {
        event: (event) => onManagerEvent(session, event),
        shutdown: () => session.settle({ error: new Error(ENGINE_SHUT_DOWN) }),
      })
    );
    // The manager already reports everything QueueEvents would; a custom emitter may add.
    if (events) {
      const watcher = emitterWatcher(session, () => session.recheck());
      session.onSettle(watchEmitterJob(events, id, watcher));
    }
    if (session.settled) return;
    session.armDeadline(limit);
    // The subscription above is synchronous, so this read cannot miss a transition.
    void session.readFirst();
    session.scheduleReads(SAFETY_NET);
  });
}

/** TCP: QueueEvents while it delivers, WaitJob holds and state reads without it. */
function waitOverTcp(
  tcp: CommandTransport,
  id: string,
  events: FinishEvents | null,
  limit: WaitLimit
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const session = new JobWaitSession({
      reader: brokerReader(tcp, id),
      finish: settleWith(resolve, reject),
      scheduler: readSchedulerFor(tcp, TCP_READS_PER_SECOND),
      // Before settling on a missing job, let the event stream deliver what it already
      // has: a job removed on completion reads as missing before its `completed` arrives.
      // A fresh round trip each time: it must start after the read that found nothing.
      confirmMissing: events
        ? () => Promise.resolve().then(() => events.waitUntilReady?.())
        : undefined,
    });
    let throughBroker = false;
    const continueWithoutEvents = () => {
      if (throughBroker || session.settled) return;
      throughBroker = true;
      void session.readFirst().then(() => {
        if (!session.settled) waitThroughBroker(session, tcp, id, limit);
      });
    };
    if (events) {
      session.onSettle(watchEmitterJob(events, id, emitterWatcher(session, continueWithoutEvents)));
      if (session.settled) return;
    }
    session.armDeadline(limit);
    if (!events) {
      continueWithoutEvents();
      return;
    }
    session.scheduleReads(SAFETY_NET);
    // Read once the stream delivers events: a job finishing before the read is seen by
    // it, one finishing after it by the stream. A stream that cannot become ready
    // (closed, or its connection refused) is waited without.
    void emitterReady(events).then(() => session.readFirst(), continueWithoutEvents);
  });
}
