interface QueueSubscribers<S> {
  readonly sockets: Set<S>;
  /** Upper bound of the connection ranks in `sockets` (stale-high after removals). */
  maxRank: number;
}

/**
 * Event-subscribed sockets grouped by queue, so a job event visits only its own
 * queue's subscribers instead of every connection. Each group iterates in
 * connection order (the order sockets were tracked), the same order a scan of the
 * connection map would visit them, so cross-socket write order is unchanged.
 */
export class EventSubscriberIndex<S extends object> {
  private readonly byQueue = new Map<string, QueueSubscribers<S>>();
  private readonly ranks = new WeakMap<S, number>();
  private nextRank = 0;

  /** Record a new connection's position in connection order. */
  track(socket: S): void {
    this.ranks.set(socket, this.nextRank++);
  }

  /** True when no socket is subscribed to any queue. */
  get isEmpty(): boolean {
    return this.byQueue.size === 0;
  }

  /** Live set of `queue`'s subscribers; removals during iteration are honored. */
  subscribers(queue: string): ReadonlySet<S> | undefined {
    return this.byQueue.get(queue)?.sockets;
  }

  add(socket: S, queue: string): void {
    const rank = this.ranks.get(socket) ?? this.nextRank++;
    const group = this.byQueue.get(queue);
    if (!group) {
      this.byQueue.set(queue, { sockets: new Set([socket]), maxRank: rank });
      return;
    }
    if (group.sockets.has(socket)) return;
    group.sockets.add(socket);
    if (rank > group.maxRank) {
      group.maxRank = rank;
      return;
    }
    // Out-of-order subscription (rare): re-sort the group into connection order.
    const ordered = [...group.sockets].sort(
      (a, b) => (this.ranks.get(a) ?? 0) - (this.ranks.get(b) ?? 0)
    );
    group.sockets.clear();
    for (const s of ordered) group.sockets.add(s);
  }

  remove(socket: S, queue: string): void {
    const group = this.byQueue.get(queue);
    if (!group?.sockets.delete(socket)) return;
    if (group.sockets.size === 0) this.byQueue.delete(queue);
  }

  clear(): void {
    this.byQueue.clear();
  }
}
