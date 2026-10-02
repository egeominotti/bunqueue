import { jobId as toJobId } from '../../../domain/types/job';
import { pausedView } from '../../../shared/pausedView';
import type { DlqQuery, JobCounts } from '../../types/adapter';
import { dlqFilter } from '../dlqFilter';
import { dlqEntryView, dlqStatsView } from '../dlqView';
import { queueLimitsView } from '../limitsView';
import { serializeMcpJob } from '../serializers';
import { EmbeddedJobBackend } from './jobs';

export class EmbeddedQueueBackend extends EmbeddedJobBackend {
  /**
   * Any engine state is accepted (waiting, prioritized, delayed, active, completed, failed,
   * paused, waiting-children). Each job carries its state, as in the TCP GetJobs reply.
   */
  async getJobs(queue: string, opts?: { state?: string; start?: number; end?: number }) {
    const state = opts?.state;
    const jobs = this.manager.getJobs(queue, { state, start: opts?.start, end: opts?.end });
    return Promise.all(
      jobs.map(async (job) =>
        serializeMcpJob(job, state ?? (await this.manager.getJobState(job.id)))
      )
    );
  }

  /** Same paused view as the TCP GetJobCounts handler: no job is counted twice. */
  getJobCounts(queue: string): Promise<JobCounts> {
    const counts = this.manager.getQueueJobCounts(queue);
    const view = pausedView(counts.waiting, counts.prioritized, this.manager.isPaused(queue));
    return Promise.resolve({
      waiting: view.waiting,
      prioritized: view.prioritized,
      delayed: counts.delayed,
      active: counts.active,
      completed: counts.completed,
      failed: counts.failed,
      paused: view.paused,
      'waiting-children': counts['waiting-children'],
    });
  }

  pauseQueue(queue: string) {
    this.manager.pause(queue);
    return Promise.resolve();
  }

  resumeQueue(queue: string) {
    this.manager.resume(queue);
    return Promise.resolve();
  }

  drainQueue(queue: string) {
    return Promise.resolve(this.manager.drain(queue));
  }

  obliterateQueue(queue: string) {
    this.manager.obliterate(queue);
    return Promise.resolve();
  }

  listQueues() {
    return Promise.resolve(this.manager.listQueues());
  }

  countJobs(queue: string) {
    return Promise.resolve(this.manager.count(queue));
  }

  cleanQueue(queue: string, graceMs: number, state?: string, limit?: number) {
    return Promise.resolve(this.manager.clean(queue, graceMs, state, limit));
  }

  isPaused(queue: string) {
    return Promise.resolve(this.manager.isPaused(queue));
  }

  getCountsPerPriority(queue: string) {
    return Promise.resolve(this.manager.getCountsPerPriority(queue));
  }

  getDlq(queue: string, limit?: number) {
    return Promise.resolve(
      this.manager.getDlq(queue, limit).map((job) => serializeMcpJob(job, 'failed'))
    );
  }

  /** Same selection as the TCP `Dlq` handler: engine filter, then the first limit + 1. */
  getDlqEntries(queue: string, query: DlqQuery) {
    const raw = this.manager.getDlqEntries(queue, dlqFilter(query)).slice(0, query.limit + 1);
    const entries = raw
      .slice(0, query.limit)
      .map((entry) =>
        dlqEntryView(
          entry as unknown as Record<string, unknown>,
          serializeMcpJob(entry.job, 'failed')
        )
      );
    return Promise.resolve({ entries, hasMore: raw.length > query.limit });
  }

  getDlqStats(queue: string) {
    return Promise.resolve(dlqStatsView(this.manager.getDlqStats(queue)));
  }

  retryDlq(queue: string, id?: string) {
    return Promise.resolve(this.manager.retryDlq(queue, id ? toJobId(id) : undefined));
  }

  purgeDlq(queue: string) {
    return Promise.resolve(this.manager.purgeDlq(queue));
  }

  retryCompleted(queue: string, id?: string) {
    return Promise.resolve(this.manager.retryCompleted(queue, id ? toJobId(id) : undefined));
  }

  setRateLimit(queue: string, limit: number, durationMs?: number) {
    this.manager.setRateLimit(queue, limit, durationMs);
    return Promise.resolve();
  }

  clearRateLimit(queue: string) {
    this.manager.clearRateLimit(queue);
    return Promise.resolve();
  }

  setConcurrency(queue: string, limit: number) {
    this.manager.setConcurrency(queue, limit);
    return Promise.resolve();
  }

  clearConcurrency(queue: string) {
    this.manager.clearConcurrency(queue);
    return Promise.resolve();
  }

  async getQueueLimits(queue: string) {
    const status = this.manager.getQueueLimitStatus(queue);
    const [counts, paused] = await Promise.all([this.getJobCounts(queue), this.isPaused(queue)]);
    return queueLimitsView(queue, status, counts.active, paused);
  }
}
