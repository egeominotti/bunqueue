import type { DlqQuery, JobCounts } from '../../types/adapter';
import { dlqEntryJob, dlqEntryView, dlqStatsView } from '../dlqView';
import { dlqFilter } from '../dlqFilter';
import { queueLimitsView } from '../limitsView';
import { TcpJobBackend } from './jobs';
import { numberField, replyData } from './wire';

export class TcpQueueBackend extends TcpJobBackend {
  async getJobs(queue: string, opts?: { state?: string; start?: number; end?: number }) {
    const start = opts?.start ?? 0;
    const hasEnd = opts?.end !== undefined && opts.end >= 0;
    const response = await this.send({
      cmd: 'GetJobs',
      queue,
      state: opts?.state,
      offset: start,
      limit: hasEnd ? Math.max(0, (opts?.end as number) - start) : undefined,
    });
    return ((response.jobs as Array<Record<string, unknown>>) ?? []).map((job) =>
      this.parseJob(job)
    );
  }

  async getJobCounts(queue: string): Promise<JobCounts> {
    const response = await this.send({ cmd: 'GetJobCounts', queue });
    const counts = (response.counts as Record<string, number> | undefined) ?? {};
    return {
      waiting: counts.waiting ?? 0,
      prioritized: counts.prioritized ?? 0,
      delayed: counts.delayed ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      paused: counts.paused ?? 0,
      'waiting-children': counts['waiting-children'] ?? 0,
    };
  }

  async pauseQueue(queue: string) {
    await this.send({ cmd: 'Pause', queue });
  }

  async resumeQueue(queue: string) {
    await this.send({ cmd: 'Resume', queue });
  }

  async drainQueue(queue: string) {
    return numberField(await this.send({ cmd: 'Drain', queue }), 'count');
  }

  async obliterateQueue(queue: string) {
    await this.send({ cmd: 'Obliterate', queue });
  }

  async listQueues() {
    const response = await this.send({ cmd: 'ListQueues' });
    return (response.queues as string[]) ?? [];
  }

  async countJobs(queue: string) {
    const response = await this.send({ cmd: 'Count', queue });
    return (response.count as number) ?? 0;
  }

  async cleanQueue(queue: string, graceMs: number, state?: string, limit?: number) {
    const response = await this.send({ cmd: 'Clean', queue, grace: graceMs, state, limit });
    return (response.ids as string[]) ?? [];
  }

  async isPaused(queue: string) {
    const response = await this.send({ cmd: 'IsPaused', queue });
    return (response.paused as boolean) ?? false;
  }

  async getCountsPerPriority(queue: string) {
    const response = await this.send({ cmd: 'GetCountsPerPriority', queue });
    return (response.counts as Record<number, number>) ?? {};
  }

  async getDlq(queue: string, limit?: number) {
    const response = await this.send({ cmd: 'Dlq', queue, count: limit });
    return ((response.jobs as Array<Record<string, unknown>>) ?? []).map((job) =>
      this.parseJob(job, 'failed')
    );
  }

  /** One extra entry is requested to report `hasMore` without counting the whole DLQ. */
  async getDlqEntries(queue: string, query: DlqQuery) {
    const filter = dlqFilter(query);
    const response = await this.send({ cmd: 'Dlq', queue, filter, count: query.limit + 1 });
    const raw = Array.isArray(response.entries) ? (response.entries as unknown[]) : [];
    const entries = raw.slice(0, query.limit).map((entry) => {
      const job = this.parseJob(dlqEntryJob(entry), 'failed');
      return dlqEntryView(entry as Record<string, unknown>, job);
    });
    return { entries, hasMore: raw.length > query.limit };
  }

  async getDlqStats(queue: string) {
    return dlqStatsView(replyData(await this.send({ cmd: 'GetDlqStats', queue })).stats);
  }

  async retryDlq(queue: string, id?: string) {
    // The broker reads the target as `jobId`; without it the whole DLQ is retried.
    return numberField(await this.send({ cmd: 'RetryDlq', queue, jobId: id }), 'count');
  }

  async purgeDlq(queue: string) {
    return numberField(await this.send({ cmd: 'PurgeDlq', queue }), 'count');
  }

  async retryCompleted(queue: string, id?: string) {
    return numberField(await this.send({ cmd: 'RetryCompleted', queue, id }), 'count');
  }

  async setRateLimit(queue: string, limit: number, durationMs?: number) {
    await this.send({ cmd: 'RateLimit', queue, limit, duration: durationMs });
  }

  async clearRateLimit(queue: string) {
    await this.send({ cmd: 'RateLimitClear', queue });
  }

  async setConcurrency(queue: string, limit: number) {
    await this.send({ cmd: 'SetConcurrency', queue, limit });
  }

  async clearConcurrency(queue: string) {
    await this.send({ cmd: 'ClearConcurrency', queue });
  }

  async getQueueLimits(queue: string) {
    const [reply, counts, paused] = await Promise.all([
      this.send({ cmd: 'GetQueueLimits', queue }),
      this.getJobCounts(queue),
      this.isPaused(queue),
    ]);
    return queueLimitsView(queue, replyData(reply).limits, counts.active, paused);
  }
}
