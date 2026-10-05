import type { JobId } from '../../domain/types/job';
import { assertLockDuration, delayArgument } from '../../domain/job/options';
import {
  normalizeProgress,
  priorityChange,
  validateUpdatedJobData,
} from '../../domain/job/mutations';
import * as lockMgr from '../lockManager';
import * as jobMgmt from '../operations/jobManagement';
import * as jobPromotion from '../operations/jobPromotion';
import * as jobTransitions from '../operations/jobStateTransitions';
import { QueueManagerConfiguration } from './configuration';

export class QueueManagerJobManagement extends QueueManagerConfiguration {
  async cancel(jobId: JobId): Promise<boolean> {
    try {
      return await jobMgmt.cancelJob(jobId, this.contextFactory.getJobMgmtContext());
    } finally {
      this.syncJobTimeout(jobId);
    }
  }

  async updateProgress(jobId: JobId, progress: number, message?: string): Promise<boolean> {
    // 2.9.10's stored value for any progress (never NaN, never a throw).
    const update = normalizeProgress(progress, message);
    return jobMgmt.updateJobProgress(
      jobId,
      update.progress,
      this.contextFactory.getJobMgmtContext(),
      update.message
    );
  }

  async updateJobData(jobId: JobId, data: unknown): Promise<boolean> {
    // Serializable, with no size limit: 2.9.10 accepted any update size.
    const dataError = validateUpdatedJobData(data);
    if (dataError) throw new Error(dataError);
    return jobMgmt.updateJobData(jobId, data, this.contextFactory.getJobMgmtContext());
  }

  async changePriority(jobId: JobId, priority: number, lifo?: boolean): Promise<boolean> {
    // Any finite priority (missing = 0), grouped jobs included, and a boolean lifo, as
    // 2.9.10 applied them.
    const change = priorityChange(priority, lifo);
    return jobMgmt.changeJobPriority(
      jobId,
      change.priority,
      this.contextFactory.getJobMgmtContext(),
      change.lifo
    );
  }

  async promote(jobId: JobId): Promise<boolean> {
    return jobPromotion.promoteJob(jobId, this.contextFactory.getJobMgmtContext());
  }

  async promoteJobs(queue: string, count?: number): Promise<number> {
    return jobPromotion.promoteJobs(queue, count, this.contextFactory.getJobMgmtContext());
  }

  async moveToDelayed(jobId: JobId, delay: number, token?: string): Promise<boolean> {
    return this.changeDelay(jobId, delay, token);
  }

  async changeDelay(jobId: JobId, rawDelay: number, token?: string): Promise<boolean> {
    // A NaN delay would never come due; a past run time (negative) is "now".
    const delay = delayArgument(rawDelay);
    try {
      const lockContext = this.contextFactory.getLockContext();
      this.assertLeaseToken(jobId, token, lockContext);
      const context = this.contextFactory.getJobMgmtContext();
      const location = context.jobIndex.get(jobId);
      let moved: boolean;
      if (location?.type === 'queue') {
        moved = await jobTransitions.changeWaitingDelay(jobId, delay, context);
      } else {
        moved = await jobMgmt.moveJobToDelayed(jobId, delay, context);
      }
      if (moved) lockMgr.releaseLock(jobId, lockContext, token);
      return moved;
    } finally {
      this.syncJobTimeout(jobId);
    }
  }

  async moveActiveToWait(jobId: JobId, token?: string): Promise<boolean> {
    try {
      const lockContext = this.contextFactory.getLockContext();
      this.assertLeaseToken(jobId, token, lockContext);
      const moved = await jobTransitions.moveActiveToWait(
        jobId,
        this.contextFactory.getJobMgmtContext()
      );
      if (moved) lockMgr.releaseLock(jobId, lockContext, token);
      return moved;
    } finally {
      this.syncJobTimeout(jobId);
    }
  }

  async changeWaitingDelay(jobId: JobId, delay: number): Promise<boolean> {
    return jobTransitions.changeWaitingDelay(
      jobId,
      delayArgument(delay),
      this.contextFactory.getJobMgmtContext()
    );
  }

  async moveToWaitingChildren(jobId: JobId, token?: string): Promise<boolean> {
    try {
      const lockContext = this.contextFactory.getLockContext();
      this.assertLeaseToken(jobId, token, lockContext);
      const moved = await jobTransitions.moveToWaitingChildren(
        jobId,
        this.contextFactory.getJobMgmtContext()
      );
      if (moved) lockMgr.releaseLock(jobId, lockContext, token);
      return moved;
    } finally {
      this.syncJobTimeout(jobId);
    }
  }

  async extendLock(
    jobId: JobId | string,
    token: string | null,
    duration: number
  ): Promise<boolean> {
    assertLockDuration(duration, 'duration');
    const targetId = typeof jobId === 'string' ? (jobId as JobId) : jobId;
    const context = this.contextFactory.getLockContext();
    if (token) return lockMgr.renewJobLock(targetId, token, context, duration);
    const lock = lockMgr.getLockInfo(targetId, context);
    return lock ? lockMgr.renewJobLock(targetId, lock.token, context, duration) : false;
  }

  async discard(jobId: JobId, token?: string): Promise<boolean> {
    try {
      this.assertLeaseToken(jobId, token, this.contextFactory.getLockContext());
      return await jobMgmt.discardJob(jobId, this.contextFactory.getJobMgmtContext());
    } finally {
      this.syncJobTimeout(jobId);
    }
  }
}
