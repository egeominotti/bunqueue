import type { Job, JobId } from '../../types/job';
import type { GroupPullOptions, GroupRateLimitOverride } from '../../types/group';
import type { GroupCandidate, GroupEligibility } from '../groupScheduler';
import type { QueueState } from '../../types/queue';
import { ShardKeys } from './keys';

/** Queue rate, concurrency, and resource ownership operations. */
export class ShardLimits extends ShardKeys {
  hasGroupScheduler(queue: string): boolean {
    return this.groupScheduler.isActive(queue);
  }
  assignGroupFifoOrder(job: Job): void {
    this.groupScheduler.assignFifoOrder(job);
  }
  observeGroupFifoOrder(job: Job): void {
    this.groupScheduler.observeFifoOrder(job);
  }
  peekGroupCandidate(queue: string, now: number, options?: GroupPullOptions): GroupCandidate {
    return this.groupScheduler.peek(
      queue,
      now,
      (groupId): GroupEligibility =>
        this.groupLimiterManager.status(
          queue,
          groupId,
          options,
          this.getGroupActiveCount(queue, groupId),
          now
        ),
      options?.affinity
    );
  }
  /** Admit job `jobId` into its group; on success the job holds one group slot. */
  acquireGroup(
    queue: string,
    groupId: string,
    jobId: JobId,
    options?: GroupPullOptions,
    now?: number
  ): boolean {
    const acquired = this.groupLimiterManager.acquire(
      queue,
      groupId,
      options,
      this.getGroupActiveCount(queue, groupId),
      now
    );
    if (acquired) this.activateGroup(queue, groupId, jobId);
    return acquired;
  }
  advanceGroup(queue: string, groupId: string): void {
    this.groupScheduler.advance(queue, groupId);
  }
  getGroupJobsCount(queue: string, groupId: string): number {
    return this.groupScheduler.getGroupJobsCount(queue, groupId);
  }
  getGroupsJobsCount(queue: string): number {
    return this.groupScheduler.getGroupsJobsCount(queue);
  }
  cleanExpiredGroupWindows(now: number): void {
    this.groupLimiterManager.pruneExpiredWindows(now);
  }
  clearEmptyGroupRuntime(queue: string): void {
    this.groupScheduler.clearQueue(queue);
    this.clearActiveGroups(queue);
  }
  setGroupRateLimit(queue: string, groupId: string, max: number, duration: number): void {
    this.groupLimiterManager.setRateLimit(queue, groupId, max, duration);
  }
  getGroupRateLimit(queue: string, groupId: string): GroupRateLimitOverride | null {
    return this.groupLimiterManager.getRateLimit(queue, groupId);
  }
  removeGroupRateLimit(queue: string, groupId: string): number {
    return this.groupLimiterManager.removeRateLimit(queue, groupId);
  }
  getGroupRateLimitTtl(queue: string, groupId: string, maxJobs?: number): number {
    return this.groupLimiterManager.getRateLimitTtl(queue, groupId, maxJobs);
  }
  setGroupConcurrency(queue: string, groupId: string, concurrency: number): void {
    this.groupLimiterManager.setConcurrency(queue, groupId, concurrency);
  }
  getGroupConcurrency(queue: string, groupId: string): number | null {
    return this.groupLimiterManager.getConcurrency(queue, groupId);
  }
  removeGroupConcurrency(queue: string, groupId: string): number {
    return this.groupLimiterManager.removeConcurrency(queue, groupId);
  }
  pauseGroup(queue: string, groupId: string): boolean {
    return this.groupLimiterManager.pause(queue, groupId);
  }
  resumeGroup(queue: string, groupId: string): boolean {
    return this.groupLimiterManager.resume(queue, groupId);
  }
  isGroupPaused(queue: string, groupId: string): boolean {
    return this.groupLimiterManager.isPaused(queue, groupId);
  }
  rateLimitGroup(queue: string, groupId: string, duration: number): void {
    this.groupLimiterManager.rateLimit(queue, groupId, duration);
  }
  setRateLimit(queue: string, limit: number, durationMs?: number, ttlMs?: number): void {
    this.limiterManager.setRateLimit(queue, limit, durationMs, ttlMs);
  }
  clearRateLimit(queue: string): void {
    this.limiterManager.clearRateLimit(queue);
  }
  expireRateLimitIfNeeded(queue: string): void {
    this.limiterManager.expireRateLimitIfNeeded(queue);
  }
  tryAcquireRateLimit(queue: string): boolean {
    return this.limiterManager.tryAcquireRateLimit(queue);
  }
  getRateLimit(queue: string): { max: number; duration: number } | null {
    return this.limiterManager.getRateLimit(queue);
  }
  getRateLimitTtl(queue: string, maxJobs?: number): number {
    return this.limiterManager.getRateLimitTtl(queue, maxJobs);
  }
  setConcurrency(queue: string, limit: number, activeJobIds?: () => Iterable<JobId>): void {
    this.limiterManager.setConcurrency(queue, limit, activeJobIds);
  }
  clearConcurrency(queue: string): void {
    this.limiterManager.clearConcurrency(queue);
  }
  tryAcquireConcurrency(queue: string, jobId: JobId): boolean {
    return this.limiterManager.tryAcquireConcurrency(queue, jobId);
  }
  releaseConcurrency(queue: string, jobId: JobId): void {
    this.limiterManager.releaseConcurrency(queue, jobId);
  }
  getConcurrency(queue: string): number | null {
    return this.limiterManager.getConcurrency(queue);
  }
  isConcurrencyMaxed(queue: string): boolean {
    return this.limiterManager.isConcurrencyMaxed(queue);
  }
  get queueState(): Map<string, QueueState> {
    return this.limiterManager.getStateMap();
  }
  clearQueueLimiters(queue: string): void {
    this.limiterManager.deleteQueue(queue);
  }
  /**
   * Release what the job `ownerId` held while active: unique key, group and concurrency
   * slot. Every release is owner-checked, so a duplicate or late call is a no-op.
   */
  releaseJobResources(
    queue: string,
    uniqueKey: string | null,
    groupId: string | null,
    ownerId: JobId
  ): void {
    if (uniqueKey) this.releaseUniqueKeyIfOwned(queue, uniqueKey, ownerId);
    if (groupId) this.releaseGroup(queue, groupId, ownerId);
    this.releaseConcurrency(queue, ownerId);
  }
}
