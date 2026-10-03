/**
 * Long-poll slots per connection of a pool.
 *
 * A long-poll command (WaitJob) keeps one of the broker's 50 per-connection command
 * slots for its whole hold, and one of the connection's `maxInFlight` client slots.
 * A lease reserves such a slot on the connection with the fewest leases (a connected
 * one on a tie; an idle connection connects for it), so long-polls spread over the
 * whole pool, and only while that connection has fewer than the caller's limit: each
 * connection keeps room for ordinary commands.
 */

import type { SendOptions } from './types';

type Reply = Record<string, unknown>;

/** A reserved long-poll slot on one connection; `release` is idempotent. */
export interface LongPollLease {
  send(command: Record<string, unknown>, options?: SendOptions): Promise<Reply>;
  release(): void;
}

interface LongPollClient {
  isConnected(): boolean;
}

export class LongPollRouter {
  private readonly leased: number[] = [];

  /**
   * A lease on the least-leased connection below `limit`, or null when every one is at
   * it. `sendOn(index, ...)` sends on that connection (the pool checks it is open).
   */
  reserve(
    clients: readonly LongPollClient[],
    limit: number,
    sendOn: (
      index: number,
      command: Record<string, unknown>,
      options?: SendOptions
    ) => Promise<Reply>
  ): LongPollLease | null {
    let chosen = -1;
    for (let index = 0; index < clients.length; index++) {
      const load = this.leased[index] ?? 0;
      if (load >= limit) continue;
      const best = chosen < 0 ? Number.POSITIVE_INFINITY : (this.leased[chosen] ?? 0);
      const tieBreak =
        load === best && clients[index].isConnected() && !clients[chosen].isConnected();
      if (load < best || tieBreak) chosen = index;
    }
    if (chosen < 0) return null;
    this.leased[chosen] = (this.leased[chosen] ?? 0) + 1;
    let held = true;
    return {
      send: (command, options) => sendOn(chosen, command, options),
      release: () => {
        if (!held) return;
        held = false;
        this.leased[chosen]--;
      },
    };
  }
}
