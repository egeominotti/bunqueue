import type { Job, JobId } from '../../types/job';
import type { QueueState } from '../../types/queue';
import type { ShardOptions } from '../../types/shard';
import { DependencyTracker } from '../dependencyTracker';
import { DlqShard } from '../dlqShard';
import { LimiterManager } from '../limiterManager';
import { IndexedPriorityQueue } from '../priorityQueue';
import { GroupLimiterManager } from '../groupLimiterManager';
import { GroupScheduler } from '../groupScheduler';
import { ShardCounters } from '../shardCounters';
import { TemporalManager } from '../temporalManager';
import { UniqueKeyManager } from '../uniqueKeyManager';
import { WaiterManager } from '../waiterManager';

/** Owns the collaborating shard managers and basic queue/waiter operations. */
export class ShardState {
  readonly queues = new Map<string, IndexedPriorityQueue>();
  readonly activeGroups = new Map<string, Set<string>>();
  readonly activeGroupCounts = new Map<string, Map<string, number>>();
  /** Per queue: active job id -> the group whose slot it holds (source of the counts). */
  readonly activeGroupHolders = new Map<string, Map<JobId, string>>();
  protected readonly uniqueKeyManager = new UniqueKeyManager();
  protected readonly dlqManager: DlqShard;
  protected readonly limiterManager = new LimiterManager();
  protected readonly groupLimiterManager = new GroupLimiterManager();
  protected readonly groupScheduler = new GroupScheduler();
  protected readonly dependencyTracker = new DependencyTracker();
  protected readonly temporalManager = new TemporalManager();
  protected readonly waiterManager = new WaiterManager();
  protected readonly counters: ShardCounters;

  constructor(options: ShardOptions = {}) {
    this.counters = new ShardCounters(this.temporalManager);
    this.dlqManager = new DlqShard({
      incrementDlq: () => {
        this.counters.incrementDlq();
      },
      decrementDlq: (count) => {
        this.counters.decrementDlq(count);
      },
      onEvict: options.onDlqEvicted,
    });
  }

  notify(queue?: string): void {
    this.waiterManager.notify(queue);
  }

  notifyBatch(count: number): void;
  notifyBatch(queue: string, count: number): void;
  notifyBatch(queueOrCount: string | number, maybeCount?: number): void {
    if (typeof queueOrCount === 'number') {
      this.waiterManager.notifyBatch(queueOrCount);
    } else {
      this.waiterManager.notifyBatch(queueOrCount, maybeCount ?? 0);
    }
  }

  waitForJob(timeoutMs: number, signal?: AbortSignal): Promise<void>;
  waitForJob(queue: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  waitForJob(
    queueOrTimeout: string | number,
    maybeTimeoutOrSignal?: number | AbortSignal,
    maybeSignal?: AbortSignal
  ): Promise<void> {
    if (typeof queueOrTimeout === 'number') {
      return this.waiterManager.waitForJob(
        queueOrTimeout,
        maybeTimeoutOrSignal as AbortSignal | undefined
      );
    }
    return this.waiterManager.waitForJob(
      queueOrTimeout,
      typeof maybeTimeoutOrSignal === 'number' ? maybeTimeoutOrSignal : 0,
      maybeSignal
    );
  }

  getQueue(name: string): IndexedPriorityQueue {
    let queue = this.queues.get(name);
    if (!queue) {
      const hooks = {
        onInsert: (job: Job) =>
          this.groupScheduler.insert(name, job, () => this.queues.get(name)?.values() ?? []),
        onRemove: (job: Job) => this.groupScheduler.remove(name, job),
      };
      queue = new IndexedPriorityQueue(hooks, undefined, undefined, true);
      this.queues.set(name, queue);
    }
    return queue;
  }

  /**
   * Earliest runAt when no job of an existing queue can be ready or expired at `now`;
   * `undefined` otherwise (or when the queue does not exist yet).
   */
  idleRunAt(name: string, now: number): number | null | undefined {
    return this.queues.get(name)?.idleRunAt(now);
  }

  /** The last pull scan of an existing queue found no job due. */
  markExhausted(name: string): void {
    this.queues.get(name)?.markExhausted();
  }

  getState(name: string): QueueState {
    return this.limiterManager.getState(name);
  }

  isPaused(name: string): boolean {
    return this.limiterManager.isPaused(name);
  }

  pause(name: string): void {
    this.limiterManager.pause(name);
  }

  resume(name: string): void {
    this.limiterManager.resume(name);
    this.waiterManager.notify(name);
  }

  getQueueNames(): string[] {
    const names = new Set<string>();
    for (const name of this.queues.keys()) names.add(name);
    for (const name of this.dlqManager.getQueueNames()) names.add(name);
    for (const name of this.limiterManager.getQueueNames()) names.add(name);
    return Array.from(names);
  }

  getConfiguredQueueNames(): string[] {
    return Array.from(
      new Set([
        ...this.limiterManager.getConfiguredQueueNames(),
        ...this.dlqManager.getConfiguredQueueNames(),
        ...this.groupLimiterManager.getQueueNames(),
      ])
    );
  }
}
