/**
 * A TCP wait without events: WaitJob holds report completions, state reads the rest.
 *
 * The broker's WaitJob settles only on completion, so a failure is seen by a state
 * read: the wait reads on the `BROKER_READS` schedule (1 s, then 2, 4 ... and every
 * 30 s, jittered, within the transport's read budget). Meanwhile, with one of the
 * transport's hold slots (`holdLimiter.ts`: per connection, FIFO, kept across holds),
 * it holds WaitJob for 1 s, then 2, 4 ... up to 30 s per hold (never past the TTL,
 * so always inside the broker's 600000 ms bound) and settles at once on a
 * completion. Each hold runs under its own command timeout
 * (hold + 5 s), so neither the connection's `commandTimeout` nor its
 * consecutive-timeout reconnect mistakes a hold for a dead link. A transient failure
 * (rate limit, timeout, lost connection) is retried with the next hold.
 */

import { HOLD_TURN_MS, holdLimiterFor, type HoldSlot } from './holdLimiter';
import { BROKER_READS } from './readScheduler';
import type { JobWaitSession } from './session';
import {
  commandError,
  isTransientError,
  isTransientReply,
  type CommandTransport,
  type WaitLimit,
} from './types';

export const BROKER_HOLD_FIRST_MS = 1_000;
export const BROKER_HOLD_MAX_MS = 30_000;
/** How long a WaitJob reply may take beyond its hold, as the legacy SDK allows. */
export const BROKER_REPLY_MARGIN_MS = 5_000;

type Reply = Record<string, unknown>;

/** Continue `session` without events; its first state read has already run. */
export function waitThroughBroker(
  session: JobWaitSession,
  tcp: CommandTransport,
  id: string,
  limit: WaitLimit
): void {
  session.scheduleReads(BROKER_READS);
  void holdUntilSettled(session, tcp, id, limit).catch((error: unknown) => session.fail(error));
}

async function holdUntilSettled(
  session: JobWaitSession,
  tcp: CommandTransport,
  id: string,
  limit: WaitLimit
): Promise<void> {
  const limiter = holdLimiterFor(tcp);
  let slot: HoldSlot | null = null;
  let cancel: () => void = () => undefined;
  session.onSettle(() => {
    cancel();
    slot?.release();
  });
  let hold = BROKER_HOLD_FIRST_MS;
  let heldSince = 0;
  while (!session.settled) {
    if (!slot) {
      const request = limiter.acquire();
      cancel = request.cancel;
      const granted = await request.slot;
      if (!granted) return;
      if (session.settled) {
        granted.release();
        return;
      }
      slot = granted;
      heldSince = Date.now();
    }
    const remaining = limit.deadline - Date.now();
    // The deadline timer settles the wait, and the settle releases the slot.
    if (remaining <= 0) return;
    const timeout = Math.ceil(Math.min(hold, remaining));
    const sentAt = Date.now();
    let response: Reply | null = null;
    try {
      response = await slot.send(
        { cmd: 'WaitJob', id, timeout },
        { timeout: timeout + BROKER_REPLY_MARGIN_MS }
      );
    } catch (error) {
      if (!isTransientError(error)) throw error;
    }
    if (session.settled) return;
    if (response?.ok === true && response.completed === true) {
      session.settle({ value: response.result });
      return;
    }
    if (response && response.ok !== true && !isTransientReply(response)) {
      await settleOnRefusal(session, response);
      if (session.settled) return;
    }
    // A reply before the hold ended (or a failed one) must not turn this into a busy loop.
    await session.sleep(sentAt + timeout - Date.now());
    hold = Math.min(hold * 2, BROKER_HOLD_MAX_MS);
    // After a full turn, a wait whose job is still running yields to a queued one.
    if (Date.now() - heldSince >= HOLD_TURN_MS && limiter.contended) {
      slot.release();
      slot = null;
    }
  }
}

/** "Job not found" once the job is gone, or a refusal: a state read decides. */
async function settleOnRefusal(session: JobWaitSession, response: Reply): Promise<void> {
  try {
    const outcome = await session.outcome();
    session.settle(outcome ?? { error: commandError(response, 'WaitJob failed') });
  } catch (error) {
    if (!isTransientError(error)) session.fail(error);
  }
}
