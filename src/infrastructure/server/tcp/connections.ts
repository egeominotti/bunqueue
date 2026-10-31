import type { Socket } from 'bun';
import type { QueueManager } from '../../../application/queueManager';
import type { JobEvent } from '../../../domain/types/queue';
import { uuid } from '../../../shared/hash';
import { tcpLog } from '../../../shared/logger';
import { encodeMessagePack } from '../../../shared/msgpack';
import { Semaphore } from '../../../shared/semaphore';
import { safeTimeout } from '../../../shared/timers';
import { FrameParser, createConnectionState } from '../protocol';
import { getRateLimiter } from '../rateLimiter';
import { SocketWriteQueue } from '../socketWriteQueue';
import type { TcpConnectionData } from '../types/tcpServer';
import { releaseClientJobsWithRetry } from './clientRelease';
import { MAX_CONCURRENT_PER_CONNECTION } from './constants';
import {
  acceptsEventType,
  type EncodedEvents,
  type EventTypeFilter,
  framesFor,
  joinFrames,
  wantedEventTypes,
} from './eventFanout';
import { EventSubscriberIndex } from './eventSubscriberIndex';

/** Owns per-client state, slowloris timers, backpressure, and disconnect cleanup. */
export class TcpConnectionRegistry {
  readonly connections = new Map<string, Socket<TcpConnectionData>>();
  private eventUnsubscribe: (() => void) | null = null;
  /** Live connections (in `connections`) whose `eventQueue` is set, keyed by that queue. */
  private readonly eventSubscribers = new EventSubscriberIndex<Socket<TcpConnectionData>>();
  /** Set by a post-drain `closeAll`: jobs still held are abandoned, not released. */
  private abandonJobsOnClose = false;

  constructor(
    private readonly queueManager: QueueManager,
    private readonly authTokens: Set<string>,
    private readonly idleTimeoutMs: number,
    private readonly maxWriteQueueBytes: number,
    private readonly drainSignal?: AbortSignal
  ) {}

  init(socket: Socket<TcpConnectionData>): void {
    if (socket.data) return;
    const clientId = uuid();
    const abortController = new AbortController();
    socket.data = {
      state: createConnectionState(clientId),
      abortController,
      frameParser: new FrameParser(),
      ctx: {
        queueManager: this.queueManager,
        authTokens: this.authTokens,
        authenticated: this.authTokens.size === 0,
        clientId,
        // Pulls stop when this client disconnects or when the server starts draining.
        signal: this.drainSignal
          ? AbortSignal.any([abortController.signal, this.drainSignal])
          : abortController.signal,
        drainSignal: this.drainSignal,
        // `close()` aborts it, including when `stop()` terminates the connection.
        connectionSignal: abortController.signal,
      },
      semaphore: new Semaphore(MAX_CONCURRENT_PER_CONNECTION),
      writeQueue: new SocketWriteQueue(this.maxWriteQueueBytes),
      stallTimer: null,
      eventQueue: null,
      eventTypes: null,
    };
    this.connections.set(clientId, socket);
    this.eventSubscribers.track(socket);
    this.queueManager.emitDashboardEvent('client:connected', { clientId, transport: 'tcp' });
  }

  clearStallTimer(socket: Socket<TcpConnectionData>): void {
    if (socket.data.stallTimer !== null) {
      socket.data.stallTimer.clear();
      socket.data.stallTimer = null;
    }
  }

  updateStallTimer(socket: Socket<TcpConnectionData>): void {
    if (this.idleTimeoutMs <= 0) return;
    this.clearStallTimer(socket);
    if (!socket.data.frameParser.hasPartialFrame) return;
    socket.data.stallTimer = safeTimeout(() => {
      socket.data.stallTimer = null;
      tcpLog.warn('Closing stalled connection (incomplete frame)', {
        clientId: socket.data.state.clientId,
        bufferedBytes: socket.data.frameParser.bufferedBytes,
        idleTimeoutMs: this.idleTimeoutMs,
      });
      socket.data.writeQueue.clear();
      socket.terminate();
    }, this.idleTimeoutMs);
  }

  dropForWriteOverflow(socket: Socket<TcpConnectionData>): boolean {
    const { writeQueue, state } = socket.data;
    if (!writeQueue.isOverBudget) return false;
    tcpLog.warn('Closing connection: write queue exceeded budget', {
      clientId: state.clientId,
      queuedBytes: writeQueue.bytesQueued,
    });
    this.clearStallTimer(socket);
    writeQueue.clear();
    socket.terminate();
    return true;
  }

  close(socket: Socket<TcpConnectionData>): void {
    if (!socket.data) return;
    socket.data.abortController.abort();
    const clientId = socket.data.state.clientId;
    this.clearStallTimer(socket);
    socket.data.writeQueue.clear();
    if (socket.data.eventQueue !== null) {
      this.eventSubscribers.remove(socket, socket.data.eventQueue);
      socket.data.eventQueue = null;
    }
    this.connections.delete(clientId);
    this.releaseEventBridgeIfIdle();
    getRateLimiter().removeClient(clientId);
    this.queueManager.unregisterWorkersByClientId(clientId);
    this.queueManager.emitDashboardEvent('client:disconnected', {
      clientId,
      transport: 'tcp',
    });
    // Server shutdown closes every connection only after the active-job drain: a job
    // still held then is abandoned to the next process's stall recovery, not released.
    if (this.abandonJobsOnClose) return;

    releaseClientJobsWithRetry(this.queueManager, clientId).catch((error: unknown) => {
      const touched = this.queueManager.forceReleaseClientJobs(clientId);
      tcpLog.error('Client jobs release failed; fell back to force-release', {
        clientId,
        error: String(error),
        forcedJobs: touched,
        note: 'Stall detector will recover orphaned active jobs on next tick',
      });
    });
  }

  broadcast(message: unknown): void {
    const frame = FrameParser.frame(encodeMessagePack(message));
    for (const socket of this.connections.values()) {
      socket.data.writeQueue.write(socket, frame);
      if (socket.data.writeQueue.isOverBudget) {
        this.clearStallTimer(socket);
        socket.data.writeQueue.clear();
        socket.terminate();
      }
    }
  }

  subscribeEvents(
    socket: Socket<TcpConnectionData>,
    queue: string,
    eventTypes?: readonly string[] | null
  ): void {
    const previous = socket.data.eventQueue;
    socket.data.eventQueue = queue;
    // Each subscription replaces the previous one, filter included.
    socket.data.eventTypes = eventTypes ? new Set(eventTypes) : null;
    // Only live connections receive events, so a socket closed before its subscribe
    // command ran keeps `eventQueue` but stays out of the index.
    if (previous !== queue && this.connections.get(socket.data.state.clientId) === socket) {
      if (previous !== null) this.eventSubscribers.remove(socket, previous);
      this.eventSubscribers.add(socket, queue);
    }
    if (!this.eventUnsubscribe) {
      this.eventUnsubscribe = this.queueManager.subscribe(
        (event) => this.broadcastEvent(event),
        (events) => this.broadcastEvents(events)
      );
    }
  }

  unsubscribeEvents(socket: Socket<TcpConnectionData>): void {
    if (socket.data.eventQueue !== null) {
      this.eventSubscribers.remove(socket, socket.data.eventQueue);
    }
    socket.data.eventQueue = null;
    socket.data.eventTypes = null;
    this.releaseEventBridgeIfIdle();
  }

  private broadcastEvent(event: JobEvent): void {
    const subscribers = this.eventSubscribers.subscribers(event.queue);
    if (!subscribers) return;
    let frame: Uint8Array | null = null;
    for (const socket of subscribers) {
      if (!acceptsEventType(socket.data.eventTypes, event.eventType)) continue;
      frame ??= FrameParser.frame(encodeMessagePack({ type: 'event', event }));
      socket.data.writeQueue.write(socket, frame);
      this.dropForWriteOverflow(socket);
    }
  }

  /**
   * Batch path of the event bridge: a pull or ack batch emits one event per job, and
   * every TCP worker subscribes to its queue's events (for `stalled`). Each subscriber
   * gets one write carrying all of the batch's frames for its queue, in batch order,
   * instead of one write per event: the same bytes on the wire with a fraction of the
   * syscalls, which dominated the server's CPU with several worker processes. A
   * connection subscribes to one queue, so per-queue grouping keeps each socket's
   * frame order, and a socket still drops as soon as its write queue is over budget.
   * An event no subscriber of its queue accepts (`eventTypes`) is not encoded at all; a
   * filtered subscriber gets its accepted frames, and no write when there are none.
   */
  private broadcastEvents(events: readonly JobEvent[]): void {
    if (events.length === 1) {
      this.broadcastEvent(events[0]);
      return;
    }
    const encodedByQueue = new Map<string, EncodedEvents>();
    const wantedByQueue = new Map<string, EventTypeFilter>();
    for (const event of events) {
      const subscribers = this.eventSubscribers.subscribers(event.queue);
      if (!subscribers) continue;
      let wanted = wantedByQueue.get(event.queue);
      if (wanted === undefined) {
        wanted = wantedEventTypes(subscribers);
        wantedByQueue.set(event.queue, wanted);
      }
      if (!acceptsEventType(wanted, event.eventType)) continue;
      // An event that cannot be encoded is skipped alone, as the per-event path does.
      let frame: Uint8Array;
      try {
        frame = FrameParser.frame(encodeMessagePack({ type: 'event', event }));
      } catch {
        continue;
      }
      let encoded = encodedByQueue.get(event.queue);
      if (!encoded) encodedByQueue.set(event.queue, (encoded = { frames: [], types: [] }));
      encoded.frames.push(frame);
      encoded.types.push(event.eventType);
    }
    for (const [queue, encoded] of encodedByQueue) {
      const subscribers = this.eventSubscribers.subscribers(queue);
      if (!subscribers) continue;
      let all: Uint8Array | null = null;
      for (const socket of subscribers) {
        const filter = socket.data.eventTypes;
        const data = filter ? framesFor(encoded, filter) : (all ??= joinFrames(encoded.frames));
        if (!data) continue;
        socket.data.writeQueue.write(socket, data);
        this.dropForWriteOverflow(socket);
      }
    }
  }

  private releaseEventBridgeIfIdle(): void {
    if (!this.eventUnsubscribe || !this.eventSubscribers.isEmpty) return;
    this.eventUnsubscribe();
    this.eventUnsubscribe = null;
  }

  /**
   * Terminate every connection. `abandonJobs` (server shutdown after its drain) leaves
   * the jobs those clients still hold in place instead of releasing them to the queue.
   */
  closeAll(abandonJobs = false): void {
    this.abandonJobsOnClose = abandonJobs;
    this.eventUnsubscribe?.();
    this.eventUnsubscribe = null;
    this.eventSubscribers.clear();
    for (const socket of this.connections.values()) {
      this.clearStallTimer(socket);
      socket.data.eventQueue = null;
      socket.data.writeQueue.clear();
      socket.terminate();
    }
    this.connections.clear();
  }
}
