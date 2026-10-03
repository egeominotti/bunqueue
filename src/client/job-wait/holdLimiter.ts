/**
 * WaitJob hold slots per transport.
 *
 * The broker runs at most 50 commands per connection at once, and a WaitJob hold keeps
 * one of those slots until the job completes or the hold ends. Uncapped, more than
 * about 50 waits per connection took every slot: other commands queued behind the
 * holds and queued holds overran their timeout and forced reconnects. A connection
 * pool leases slots per connection (`TcpConnectionPool.reserveLongPoll`): at most
 * `HOLDS_PER_CONNECTION` on each of its connections, never more than half of a
 * connection's `maxInFlight` window, on the connection with the fewest. Any other
 * transport (a single client, a test double) gets `HOLDS_PER_CONNECTION` in total.
 *
 * A wait keeps its lease across consecutive holds, so leases pass on in FIFO order as
 * jobs finish, as the broker's own queue did when every wait held WaitJob: a wait
 * that queued behind others usually holds by the time its job completes. A wait that
 * held for `HOLD_TURN_MS` while others queue gives its lease to the next one.
 */

import type { LongPollLease } from '../tcp/longPollRouter';
import type { CommandTransport } from './types';

export const HOLDS_PER_CONNECTION = 40;
export const HOLD_TURN_MS = 30_000;

type Reply = Record<string, unknown>;

/** A transport that leases long-poll slots per connection (a TcpConnectionPool). */
interface LeasingTransport extends CommandTransport {
  reserveLongPoll(perConnection: number): LongPollLease | null;
}

function isLeasing(transport: CommandTransport): transport is LeasingTransport {
  return typeof (transport as Partial<LeasingTransport>).reserveLongPoll === 'function';
}

/** A granted hold slot. Its release waits for a hold still in flight to answer. */
export interface HoldSlot {
  send(command: Record<string, unknown>, options: { timeout: number }): Promise<Reply>;
  release(): void;
}

export class HoldLimiter {
  private counted = 0;
  private readonly waiting = new Set<(slot: HoldSlot) => void>();

  constructor(private readonly transport: CommandTransport) {}

  /** Whether other waits queue for a slot. */
  get contended(): boolean {
    return this.waiting.size > 0;
  }

  /** A slot at once or in FIFO order; `cancel` (for a settled wait) resolves null. */
  acquire(): { slot: Promise<HoldSlot | null>; cancel: () => void } {
    const granted = this.waiting.size === 0 ? this.tryReserve() : null;
    if (granted) return { slot: Promise.resolve(granted), cancel: () => undefined };
    let grant!: (slot: HoldSlot | null) => void;
    const slot = new Promise<HoldSlot | null>((resolve) => {
      grant = resolve;
    });
    this.waiting.add(grant);
    return {
      slot,
      cancel: () => {
        if (this.waiting.delete(grant)) grant(null);
      },
    };
  }

  private tryReserve(): HoldSlot | null {
    let lease: LongPollLease | null;
    if (isLeasing(this.transport)) {
      lease = this.transport.reserveLongPoll(HOLDS_PER_CONNECTION);
    } else if (this.counted < HOLDS_PER_CONNECTION) {
      this.counted++;
      lease = {
        send: (command, options) => this.transport.send(command, options),
        release: () => {
          this.counted--;
        },
      };
    } else {
      lease = null;
    }
    return lease ? this.slot(lease) : null;
  }

  private slot(lease: LongPollLease): HoldSlot {
    let inFlight: Promise<unknown> | null = null;
    let released = false;
    const free = () => {
      lease.release();
      this.drain();
    };
    return {
      send: (command, options) => {
        const reply = lease.send(command, options);
        const settled = reply.then(
          () => undefined,
          () => undefined
        );
        inFlight = settled;
        void settled.then(() => {
          if (inFlight === settled) inFlight = null;
        });
        return reply;
      },
      release: () => {
        if (released) return;
        released = true;
        // The broker keeps the slot until a hold in flight answers.
        if (inFlight) void inFlight.then(free);
        else free();
      },
    };
  }

  /** Hand freed slots to the oldest waits. */
  private drain(): void {
    for (const grant of this.waiting) {
      const slot = this.tryReserve();
      if (!slot) return;
      this.waiting.delete(grant);
      grant(slot);
    }
  }
}

const limiters = new WeakMap<object, HoldLimiter>();

export function holdLimiterFor(transport: CommandTransport): HoldLimiter {
  let limiter = limiters.get(transport);
  if (!limiter) {
    limiter = new HoldLimiter(transport);
    limiters.set(transport, limiter);
  }
  return limiter;
}
