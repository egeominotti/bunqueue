import type { JobId } from '../../domain/types/job';
import type { PostgresStoredJob } from '../../infrastructure/persistence/postgres';
import { PostgresQueueManagerState } from './state';

/** Per-job reloads of the local read model after a mutation, and direct job reads. */
export abstract class PostgresQueueManagerJobRefreshes extends PostgresQueueManagerState {
  /**
   * Reload `id` after a mutation. With `ownWrite` (this broker committed a change to the
   * job) every full-queue refresh still loading records the job first and keeps its local
   * state, so the commit cannot be rolled back however it is installed: by this reload, by
   * a direct read, or by the background retry this falls back to. Pass `false` when
   * nothing was committed.
   */
  protected async refreshJob(id: JobId, queue?: string, ownWrite = true): Promise<void> {
    const targetQueue = queue ?? this.postgresSnapshot.get(id)?.job.queue ?? '';
    if (ownWrite) this.invalidateJobQueues(id, queue);
    try {
      await this.projectionRefreshes.refreshNow(id, targetQueue, ownWrite);
    } catch {
      this.projectionRefreshes.request(id, targetQueue);
    }
  }

  protected async fetchPostgresJob(id: JobId): Promise<PostgresStoredJob | null> {
    const queue = this.postgresSnapshot.get(id)?.job.queue ?? '';
    try {
      return (await this.projectionRefreshes.refreshNow(id, queue)).row;
    } catch (error) {
      this.projectionRefreshes.request(id, queue); // the reported failure keeps a retry
      throw error;
    }
  }

  /** Reload several jobs; `ownWrite` as for `refreshJob`. */
  protected async refreshJobs(
    ids: readonly JobId[],
    queue?: string,
    ownWrite = true
  ): Promise<void> {
    const requests = [...new Set(ids)].map((id) => ({
      id,
      queue: queue ?? this.postgresSnapshot.get(id)?.job.queue ?? '',
    }));
    if (ownWrite) for (const { id } of requests) this.invalidateJobQueues(id, queue);
    try {
      await this.projectionRefreshes.refreshManyNow(requests, ownWrite);
    } catch {
      for (const request of requests) this.projectionRefreshes.request(request.id, request.queue);
    }
  }

  /** The queue the caller named and the queue the job has locally (normally the same). */
  private invalidateJobQueues(id: JobId, queue?: string): void {
    this.invalidateQueueRefreshes(queue, id);
    this.invalidateQueueRefreshes(this.postgresSnapshot.get(id)?.job.queue, id);
  }
}
