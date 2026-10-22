import type { JobId } from '../../domain/types/job';
import { PostgresQueueStore } from '../../infrastructure/persistence/postgres';
import type { PostgresDeliveredStoreEvent } from '../../infrastructure/persistence/postgres';
import { QueueManager } from '../queueManager';
import { stopBackgroundTasks } from '../backgroundTasks';
import type { PostgresQueueManagerConfig } from './config';
import { PostgresDeferredWriteQueue, throwDeferredWriteErrors } from './deferredWrites';
import {
  applyPostgresEventMetrics,
  hydratePostgresLifetimeMetrics,
  postgresEventType,
} from './lifetimeMetrics';
import { PostgresQueueSnapshot } from './snapshot';
import { PostgresStartupEventBuffer } from './startupEventBuffer';
import { PostgresOperationGate } from './operationGate';
import { applyPostgresJobProjection, PostgresProjectionRefreshes } from './projectionRefreshes';
import type { PostgresJobProjection } from './projectionRefreshes';
import { PostgresQueueRefreshes } from './queueRefreshes';
import { PostgresQueueLoads } from './queueLoads';
import { postgresRetryDelayMs } from '../../infrastructure/persistence/postgres/maintenanceSchedule';

export abstract class PostgresQueueManagerState extends QueueManager {
  protected readonly postgresStore: PostgresQueueStore;
  protected readonly postgresSnapshot: PostgresQueueSnapshot;
  protected readonly activeTokens = new Map<JobId, string>();
  protected readonly postgresReady: Promise<void>;
  private readonly queueRefreshes: PostgresQueueRefreshes;
  /** What changes while full-queue refreshes load; see `invalidateQueueRefreshes`. */
  private readonly queueLoads = new PostgresQueueLoads();
  private snapshotEventBuffer: PostgresStartupEventBuffer | null = new PostgresStartupEventBuffer();
  private terminalMetricBaselineCommitSeq = 0;
  private readonly unsubscribeEvent: () => void;
  private readonly unsubscribeInvalidation: () => void;
  private readonly writes = new PostgresDeferredWriteQueue();
  protected readonly operations: PostgresOperationGate;
  protected readonly projectionRefreshes: PostgresProjectionRefreshes;
  private shutdownPromise: Promise<void> | null = null;
  private shutdownComplete = false;
  private baseStopped = false;

  constructor(config: PostgresQueueManagerConfig) {
    const { postgres, ...baseConfig } = config;
    super(baseConfig);
    if (this.backgroundTaskHandles) stopBackgroundTasks(this.backgroundTaskHandles);
    this.postgresSnapshot = new PostgresQueueSnapshot(
      this.config.maxCompletedJobs,
      this.config.maxJobResults
    );
    this.postgresStore = new PostgresQueueStore({
      ...postgres,
      maxQueueEvents: this.config.maxQueueEvents,
      maxMetricDataPoints: this.config.maxMetricDataPoints,
      maxCompletedJobs: this.config.maxCompletedJobs,
      maxJobResults: this.config.maxJobResults,
    });
    this.operations = new PostgresOperationGate(
      this.postgresStore.config.maxConcurrentOperations,
      this.postgresStore.config.maxQueuedOperations
    );
    this.projectionRefreshes = new PostgresProjectionRefreshes(
      (requests) =>
        this.queueLoads.loadProjections(() => this.postgresStore.loadJobProjections(requests)),
      (id, projection, _ownWrite, queue) => this.applyProjection(id, projection, queue),
      (queue, id, error) => this.postgresStore.reportProjectionRefresh(queue, id, error),
      postgresRetryDelayMs(this.postgresStore.config)
    );
    this.unsubscribeEvent = this.postgresStore.onEvent((event) => this.onStoreEvent(event));
    this.unsubscribeInvalidation = this.postgresStore.onInvalidation((queue) => {
      this.scheduleQueueRefresh(queue);
    });
    this.queueRefreshes = new PostgresQueueRefreshes(
      () => this.postgresReady,
      (queue) => this.refreshQueue(queue),
      (queue, error) => this.postgresStore.reportQueueRefresh(queue, error),
      postgresRetryDelayMs(this.postgresStore.config)
    );
    this.postgresReady = this.initializePostgres();
  }
  async waitUntilReady(): Promise<void> {
    await this.postgresReady;
  }

  async flushPostgresWrites(): Promise<void> {
    await this.postgresReady;
    await this.writes.flush();
  }

  async shutdownPostgres(): Promise<void> {
    if (this.shutdownComplete) return;
    if (!this.shutdownPromise) {
      const attempt = this.performPostgresShutdown()
        .then(() => {
          this.shutdownComplete = true;
        })
        .finally(() => {
          if (this.shutdownPromise === attempt && !this.shutdownComplete) {
            this.shutdownPromise = null;
          }
        });
      this.shutdownPromise = attempt;
    }
    await this.shutdownPromise;
  }

  override shutdown(): void {
    void this.shutdownPostgres().catch(() => undefined);
  }

  private async performPostgresShutdown(): Promise<void> {
    this.queueRefreshes.stop();
    this.projectionRefreshes.close();
    const operationDrain = this.operations.closeAndDrain();
    await operationDrain;
    this.stopBaseRuntime();
    this.unsubscribeEvent();
    this.unsubscribeInvalidation();
    const errors = await this.writes.closeAndDrain();
    try {
      await this.postgresReady;
    } catch (error) {
      errors.push(error);
    }
    await Promise.allSettled([this.queueRefreshes.settled(), this.projectionRefreshes.drain()]);
    try {
      await this.postgresStore.close();
    } catch (error) {
      errors.push(error);
    }
    throwDeferredWriteErrors(errors, 'PostgreSQL shutdown failed');
  }

  protected tokenFor(id: JobId, token?: string): string | null {
    return token ?? this.activeTokens.get(id) ?? this.postgresSnapshot.get(id)?.token ?? null;
  }

  protected forgetToken(id: JobId): void {
    this.activeTokens.delete(id);
  }

  protected runPostgresOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.operations.run(operation);
  }

  /**
   * Install one queue's read model, except the jobs that changed after its snapshot (issue
   * #161): they keep their newer local state, which their own projections or reloads
   * install. A read model older than one installed meanwhile is dropped, and reloaded when
   * its load began after that one's (`PostgresQueueLoads.claim`).
   */
  protected async refreshQueue(queue: string): Promise<void> {
    const fence = this.queueLoads.begin(queue);
    try {
      const { rows, state, exists, results, horizon } =
        await this.postgresStore.loadQueueReadModel(queue);
      const claim = this.queueLoads.claim(fence, horizon);
      if (claim === 'reload') this.scheduleQueueRefresh(queue);
      if (claim !== 'install') return;
      const keep = (id: JobId) => fence.changedAfter(id, horizon);
      this.projectionRefreshes.supersedeQueue(queue, keep);
      if (exists) {
        this.postgresSnapshot.replaceQueue(queue, rows, state, results, keep);
      } else {
        for (const id of this.postgresSnapshot.removeQueue(queue, keep)) this.forgetToken(id);
      }
    } finally {
      this.queueLoads.end(fence);
    }
  }

  protected async refreshQueueAfterCommit(queue: string): Promise<void> {
    try {
      await this.refreshQueue(queue);
      this.postgresStore.reportQueueRefresh(queue, null);
    } catch (error) {
      this.postgresStore.reportQueueRefresh(queue, error);
      this.scheduleQueueRefresh(queue);
    }
  }

  protected enqueueWrite(operation: () => Promise<void>): void {
    this.writes.enqueue(operation);
  }

  private async initializePostgres(): Promise<void> {
    await this.postgresStore.initialize();
    for (let attempt = 0; attempt < 2; attempt++) {
      const buffer = this.snapshotEventBuffer;
      if (!buffer) return;
      buffer.reset();
      const { rows, results, crons, states } = await this.postgresStore.loadManagerSnapshot();
      const events = buffer.take();
      if (!events && attempt === 0) continue;
      this.postgresSnapshot.hydrate(rows);
      this.postgresSnapshot.hydrateResults(results);
      this.cronScheduler.load([...crons]);
      for (const state of states) this.postgresSnapshot.setQueueState(state);
      for (const event of events ?? []) {
        this.postgresSnapshot.apply(event);
        applyPostgresEventMetrics(this.metrics, this.perQueueMetrics, event, false);
      }
      await this.postgresStore.finalizeLifetimeMetrics((lifetimeMetrics) => {
        hydratePostgresLifetimeMetrics(this.metrics, this.perQueueMetrics, lifetimeMetrics);
        this.terminalMetricBaselineCommitSeq = lifetimeMetrics.baselineCommitSeq;
        this.snapshotEventBuffer = null;
        this.projectionRefreshes.start();
      });
      return;
    }
  }

  private scheduleQueueRefresh(queue: string): void {
    this.queueRefreshes.schedule(queue);
  }

  /**
   * Record an own commit to job `id` for every full refresh of `queue` still loading, so
   * that refresh keeps the job's local state instead of rolling the commit back. Called
   * synchronously after each own commit, before its local install; it never starts a
   * reload. A queue-wide commit needs no call: its own post-commit refresh is newer than
   * any refresh in flight (`PostgresQueueLoads.claim`). Lease renewals do not call it:
   * only a renewal's informational expiry differs.
   */
  protected invalidateQueueRefreshes(queue: string | undefined, id: JobId): void {
    this.queueLoads.jobChanged(queue, id);
  }

  private applyProjection(id: JobId, projection: PostgresJobProjection, queue: string): void {
    // Any install, own write or not, may hold a commit newer than a refresh still loading.
    const queues = [queue, this.postgresSnapshot.get(id)?.job.queue, projection.row?.job.queue];
    this.queueLoads.projectionInstalled([...queues, projection.completion?.queue], id, projection);
    applyPostgresJobProjection(this.postgresSnapshot, this.activeTokens, id, projection);
  }

  private onStoreEvent(event: PostgresDeliveredStoreEvent): void {
    this.queueLoads.jobChanged(event.queue, event.jobId, event.commitSeq);
    const startupBuffer = this.snapshotEventBuffer;
    startupBuffer?.capture(event);
    if (startupBuffer) this.postgresSnapshot.apply(event);
    if (startupBuffer?.overflowed) this.scheduleQueueRefresh(event.queue);
    else this.projectionRefreshes.request(event.jobId, event.queue);
    const mapped = postgresEventType(event.type);
    if (!mapped) return;
    if (!startupBuffer) {
      applyPostgresEventMetrics(
        this.metrics,
        this.perQueueMetrics,
        event,
        event.commitSeq > this.terminalMetricBaselineCommitSeq
      );
    }
    this.eventsManager.broadcast({
      eventType: mapped,
      queue: event.queue,
      jobId: event.jobId,
      timestamp: event.occurredAt,
      ...(Object.hasOwn(event, 'result') && { data: event.result }),
      ...(event.error !== undefined && { error: event.error }),
      ...(mapped === 'failed' && { terminal: event.state === 'failed' }),
    });
  }

  /**
   * A `completed` event WaitJob captured answers from the completion record, as
   * `waitForJobResult` does, never from the event: `onStoreEvent` delivers journal
   * events after their commit, so the event can predate a `Cancel` that has since
   * removed the completed job and cleared the record's result (issue #162). The record
   * keeps the result of a completion until a later commit changes it (removeOnComplete
   * included); after a prune, clean or obliterate the answer has no result.
   */
  override async capturedCompletionResult(jobId: JobId): Promise<unknown> {
    return (await this.getCompletionAsync(jobId)).result;
  }

  protected applyPostgresClaim(claim: Parameters<PostgresQueueSnapshot['claim']>[0]): void {
    this.projectionRefreshes.supersede(claim.job.id);
    this.invalidateQueueRefreshes(claim.job.queue, claim.job.id);
    this.activeTokens.set(claim.job.id, claim.token);
    this.postgresSnapshot.claim(claim);
  }

  private stopBaseRuntime(): void {
    if (this.baseStopped) return;
    this.baseStopped = true;
    super.shutdown();
  }
}
