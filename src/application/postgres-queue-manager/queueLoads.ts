import type { JobId } from '../../domain/types/job';

/** Recorded for a local change: newer than any read model still loading. */
const LOCAL_CHANGE = Number.POSITIVE_INFINITY;

/**
 * What changed in one queue while a full read model of it loaded (issue #161).
 *
 * The read model is one `REPEATABLE READ` snapshot with a journal horizon: it holds every
 * journaled commit up to that `commit_seq` and none after it. A received event records
 * its job with its commit sequence; an own commit, and a projection or direct read whose
 * load started after this load began, record their job as newer than any horizon. A job
 * recorded after the horizon keeps its local state when the read model is installed.
 * Each kept job has a local install that read PostgreSQL after this load began, or one
 * still pending, so a change it lacks reaches the broker through that change's own event
 * or a later full refresh. Changes are kept only while the load is in flight.
 */
export class PostgresQueueLoadFence {
  private readonly changes = new Map<JobId, number>();

  constructor(
    readonly queue: string,
    /** Load clock value when this load began. */
    readonly begun: number
  ) {}

  record(id: JobId, commitSeq: number): void {
    if (commitSeq > (this.changes.get(id) ?? 0)) this.changes.set(id, commitSeq);
  }

  /** Whether `id` changed after the snapshot at `horizon`, so its local state is kept. */
  changedAfter(id: JobId, horizon: number): boolean {
    return (this.changes.get(id) ?? 0) > horizon;
  }
}

/**
 * The fences of the full-queue loads in flight, and the horizon each queue installed while
 * other loads of it were in flight. A queue's horizon is forgotten once no load of it is
 * in flight: every later load takes its snapshot after that install, and the journal
 * horizon never decreases (see `prunePostgresEventCommits`).
 */
export class PostgresQueueLoads {
  private readonly loading = new Map<string, Set<PostgresQueueLoadFence>>();
  /** The horizon and `begun` of the read model each queue installed last. */
  private readonly installed = new Map<string, { horizon: number; begun: number }>();
  /** When each projection's load started, on the same clock as `begun`. */
  private readonly projectionLoads = new WeakMap<object, number>();
  private clock = 0;

  begin(queue: string): PostgresQueueLoadFence {
    const fence = new PostgresQueueLoadFence(queue, ++this.clock);
    const fences = this.loading.get(queue) ?? new Set<PostgresQueueLoadFence>();
    fences.add(fence);
    this.loading.set(queue, fences);
    return fence;
  }

  /** Call once the load has been installed, dropped or has failed. */
  end(fence: PostgresQueueLoadFence): void {
    const fences = this.loading.get(fence.queue);
    fences?.delete(fence);
    if (fences && fences.size > 0) return;
    this.loading.delete(fence.queue);
    this.installed.delete(fence.queue);
  }

  /** A job of `queue` changed: through a received event at `commitSeq`, or locally. */
  jobChanged(queue: string | undefined, id: JobId, commitSeq = LOCAL_CHANGE): void {
    if (queue === undefined) return;
    for (const fence of this.loading.get(queue) ?? []) fence.record(id, commitSeq);
  }

  /** Run a projection load, remembering when it started for `projectionInstalled`. */
  async loadProjections<T extends object>(
    load: () => Promise<ReadonlyMap<JobId, T>>
  ): Promise<ReadonlyMap<JobId, T>> {
    const started = ++this.clock;
    const projections = await load();
    for (const projection of projections.values()) this.projectionLoads.set(projection, started);
    return projections;
  }

  /**
   * A projection of `id` was installed. Every load of one of `queues` that began before
   * that projection's load started records the job: the projection may hold a commit the
   * load's snapshot lacks. An older projection records nothing, so the load can still
   * remove a row that a change journaling no per-job event (a drain) deleted.
   */
  projectionInstalled(queues: readonly (string | undefined)[], id: JobId, projection: object) {
    const started = this.projectionLoads.get(projection);
    if (started === undefined) return;
    for (const queue of new Set(queues)) {
      for (const fence of this.loading.get(queue ?? '') ?? []) {
        if (fence.begun < started) fence.record(id, LOCAL_CHANGE);
      }
    }
  }

  /**
   * Whether the read model `fence` loaded at `horizon` may be installed, recording it when
   * it may ('install'). One older than a read model installed while it loaded never may.
   * It is dropped ('drop') when its load began first; when it began later ('reload'), the
   * installed one took its snapshot later but kept jobs recorded since its own earlier
   * begin, so it may lack a change this load was started for (a drain whose invalidation
   * arrived meanwhile): the queue must be refreshed again. A queue-wide own commit needs
   * no record of its own: it journals at least one event, so its post-commit refresh has a
   * higher horizon than any snapshot without it.
   */
  claim(fence: PostgresQueueLoadFence, horizon: number): 'install' | 'drop' | 'reload' {
    const installed = this.installed.get(fence.queue);
    if (installed && horizon < installed.horizon) {
      return fence.begun > installed.begun ? 'reload' : 'drop';
    }
    this.installed.set(fence.queue, { horizon, begun: fence.begun });
    return 'install';
  }
}
