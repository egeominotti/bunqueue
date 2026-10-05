import type { Job, JobId } from '../../domain/types/job';
import { FailureReason } from '../../domain/types/dlq';
import { processingDeadline } from '../../domain/job/timeoutRule';
import { MinHeap } from '../../shared/minHeap';
import { queueLog } from '../../shared/logger';
import { clampTimerDelay } from '../../shared/timers';
import type { BackgroundContext } from '../types';

interface TimeoutEntry {
  readonly deadline: number;
  readonly jobId: JobId;
  readonly startedAt: number;
}

/**
 * The delay to the earliest deadline: at least 1 ms, at most one native timer
 * (`clampTimerDelay`). A deadline farther than that fires early with nothing due, and
 * `expireDue` re-arms for what remains. A NaN distance re-checks in 1 ms, as the runtime
 * itself did, instead of throwing out of `schedule()` on the pull path.
 * `processingDeadline` never yields NaN; only a NaN `jobTimeoutCheckMs` retry delay could.
 */
export function timeoutTimerDelay(deadline: number, now = Date.now()): number {
  const delay = deadline - now;
  return delay > 1 ? clampTimerDelay(delay) : 1;
}

function processingJob(ctx: BackgroundContext, id: JobId): Job | null {
  const location = ctx.jobIndex.get(id);
  if (location?.type !== 'processing') return null;
  return ctx.processingShards[location.shardIdx].get(id) ?? null;
}

async function failTimedOutJob(ctx: BackgroundContext, job: Job): Promise<void> {
  await ctx.fail(job.id, 'Job timeout exceeded', FailureReason.Timeout);
  ctx.dashboardEmit?.('job:timeout', {
    jobId: String(job.id),
    queue: job.queue,
    timeout: job.timeout,
  });
}

/** Compatibility entry point for explicit timeout checks in tests and tooling. */
export async function checkJobTimeouts(ctx: BackgroundContext): Promise<void> {
  const now = Date.now();
  const timedOut: Array<{ deadline: number; job: Job }> = [];
  for (const processingShard of ctx.processingShards) {
    for (const job of processingShard.values()) {
      const deadline = processingDeadline(job);
      if (deadline !== null && now >= deadline) timedOut.push({ deadline, job });
    }
  }
  timedOut.sort((a, b) => a.deadline - b.deadline);
  for (const { job } of timedOut) {
    if (processingJob(ctx, job.id) !== job) continue;
    try {
      await failTimedOutJob(ctx, job);
    } catch (error) {
      queueLog.error('Failed to mark timed out job as failed', {
        jobId: String(job.id),
        error: String(error),
      });
    }
  }
}

/** One timer tracks the earliest active processing deadline. */
export class JobTimeoutScheduler {
  private readonly active = new Map<JobId, TimeoutEntry>();
  private readonly deadlines = new MinHeap<TimeoutEntry>((a, b) => {
    if (a.deadline !== b.deadline) return a.deadline - b.deadline;
    return String(a.jobId).localeCompare(String(b.jobId));
  });
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armedDeadline: number | null = null;
  private stopped = true;
  private ctx: BackgroundContext | null = null;

  get pendingCount(): number {
    return this.active.size;
  }

  start(ctx: BackgroundContext): void {
    if (!this.stopped) return;
    this.ctx = ctx;
    this.stopped = false;
    this.armNext();
  }

  schedule(job: Job): void {
    if (this.stopped) return;
    const deadline = processingDeadline(job);
    const startedAt = job.startedAt;
    if (deadline === null || startedAt === null) {
      this.cancel(job.id);
      return;
    }
    const current = this.active.get(job.id);
    if (current?.deadline === deadline && current.startedAt === startedAt) return;
    const entry = { deadline, jobId: job.id, startedAt };
    this.active.set(job.id, entry);
    this.deadlines.push(entry);
    this.maybeCompact();
    if (this.armedDeadline === null || deadline < this.armedDeadline) this.armNext();
  }

  cancel(jobId: JobId): void {
    const current = this.active.get(jobId);
    if (!current) return;
    this.active.delete(jobId);
    this.maybeCompact();
    if (current.deadline === this.armedDeadline) this.armNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.armedDeadline = null;
    this.active.clear();
    this.deadlines.clear();
    this.ctx = null;
  }

  private isCurrent(entry: TimeoutEntry): boolean {
    return this.active.get(entry.jobId) === entry;
  }

  private pruneStaleRoots(): void {
    while (true) {
      const next = this.deadlines.peek();
      if (!next || this.isCurrent(next)) return;
      this.deadlines.pop();
    }
  }

  private maybeCompact(): void {
    const stale = this.deadlines.size - this.active.size;
    if (stale >= 256 && stale >= this.active.size) {
      this.deadlines.buildFrom([...this.active.values()]);
    }
  }

  private armNext(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.armedDeadline = null;
    if (this.stopped) return;
    this.pruneStaleRoots();
    const next = this.deadlines.peek();
    if (!next) return;
    this.armedDeadline = next.deadline;
    this.timer = setTimeout(() => void this.expireDue(), timeoutTimerDelay(next.deadline));
  }

  private async expireDue(): Promise<void> {
    this.timer = null;
    this.armedDeadline = null;
    const ctx = this.ctx;
    if (this.stopped || !ctx) return;
    const now = Date.now();
    const due: TimeoutEntry[] = [];
    this.pruneStaleRoots();
    while (true) {
      const next = this.deadlines.peek();
      if (!next || next.deadline > now) break;
      const entry = this.deadlines.pop();
      if (!entry) break;
      if (!this.isCurrent(entry)) continue;
      this.active.delete(entry.jobId);
      due.push(entry);
    }

    for (const entry of due) {
      const job = processingJob(ctx, entry.jobId);
      const deadline = job ? processingDeadline(job) : null;
      if (!job || job.startedAt !== entry.startedAt || deadline === null || deadline > now)
        continue;
      try {
        await failTimedOutJob(ctx, job);
      } catch (error) {
        queueLog.error('Failed to mark timed out job as failed', {
          jobId: String(entry.jobId),
          error: String(error),
        });
        const current = processingJob(ctx, entry.jobId);
        if (current?.startedAt === entry.startedAt) {
          const retry = {
            ...entry,
            deadline: Date.now() + ctx.config.jobTimeoutCheckMs,
          };
          this.active.set(entry.jobId, retry);
          this.deadlines.push(retry);
        }
      }
    }
    this.armNext();
  }
}
