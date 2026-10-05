import { type Job, jobId as toJobId } from '../../../domain/types/job';
import type {
  FailJobOptions,
  McpBulkJob,
  McpJobOptions,
  PulledJob,
  PullLockOptions,
} from '../../types/adapter';
import { admittedBulkInputs, admittedJobInput } from '../jobOptions';
import { serializeMcpJob } from '../serializers';
import { EmbeddedBackendBase } from './base';

/** A pulled job, with its lock token when the pull issued one. */
function pulled(job: Job, token: string | null | undefined): PulledJob {
  const view: PulledJob = serializeMcpJob(job, 'active');
  if (token) view.token = token;
  return view;
}

export class EmbeddedJobBackend extends EmbeddedBackendBase {
  async addJob(queue: string, name: string, data: unknown, opts?: McpJobOptions) {
    const job = await this.manager.push(queue, admittedJobInput(name, data, opts));
    return { jobId: String(job.id) };
  }

  async addJobsBulk(queue: string, jobs: McpBulkJob[]) {
    const ids = await this.manager.pushBatch(queue, admittedBulkInputs(jobs));
    return { jobIds: ids.map(String) };
  }

  async getJob(id: string) {
    const job = await this.manager.getJob(toJobId(id));
    return job ? serializeMcpJob(job, await this.manager.getJobState(job.id)) : null;
  }

  getJobState(id: string) {
    return Promise.resolve(this.manager.getJobState(toJobId(id)));
  }

  getJobResult(id: string) {
    return Promise.resolve(this.manager.getResult(toJobId(id)));
  }

  cancelJob(id: string) {
    return Promise.resolve(this.manager.cancel(toJobId(id)));
  }

  promoteJob(id: string) {
    return Promise.resolve(this.manager.promote(toJobId(id)));
  }

  updateProgress(id: string, progress: number, message?: string) {
    return Promise.resolve(this.manager.updateProgress(toJobId(id), progress, message));
  }

  updateJobData(id: string, data: unknown) {
    return Promise.resolve(this.manager.updateJobData(toJobId(id), data));
  }

  changeJobPriority(id: string, priority: number) {
    return Promise.resolve(this.manager.changePriority(toJobId(id), priority));
  }

  moveToDelayed(id: string, delay: number) {
    return Promise.resolve(this.manager.moveToDelayed(toJobId(id), delay));
  }

  discardJob(id: string) {
    return Promise.resolve(this.manager.discard(toJobId(id)));
  }

  getChildrenValues(parentJobId: string) {
    return Promise.resolve(this.manager.getChildrenValues(toJobId(parentJobId)));
  }

  async getJobByCustomId(customId: string) {
    const job = this.manager.getJobByCustomId(customId);
    return job ? serializeMcpJob(job, await this.manager.getJobState(job.id)) : null;
  }

  /**
   * Resolves true once the job has completed, including when it already had before the
   * call (same contract as the TCP WaitJob command). The completion waiter is registered
   * before the state is read, so a completion landing between the two is never missed.
   */
  async waitForJobCompletion(id: string, timeoutMs: number) {
    const jobId = toJobId(id);
    const abort = new AbortController();
    let completedMeanwhile = false;
    const waiting = this.manager
      .waitForJobCompletion(jobId, timeoutMs, abort.signal)
      .then((completed) => {
        if (completed) completedMeanwhile = true;
        return completed;
      });
    const state = await this.manager.getJobState(jobId);
    if (state === 'completed' || completedMeanwhile) {
      abort.abort();
      return true;
    }
    if (state === 'unknown' && !(await this.manager.getCompletionAsync(jobId)).found) {
      abort.abort();
      if (completedMeanwhile) return true;
      throw new Error('Job not found');
    }
    return waiting;
  }

  /** With `lock`, the job is pulled under a lease exactly like a TCP PULL with an owner. */
  async pullJob(queue: string, timeoutMs?: number, lock?: PullLockOptions) {
    if (lock) {
      const { job, token } = await this.manager.pullWithLock(
        queue,
        lock.owner,
        timeoutMs,
        lock.lockTtl
      );
      return job ? pulled(job, token) : null;
    }
    const job = await this.manager.pull(queue, timeoutMs);
    return job ? pulled(job, null) : null;
  }

  async pullJobBatch(queue: string, count: number, timeoutMs?: number, lock?: PullLockOptions) {
    if (lock) {
      const { jobs, tokens } = await this.manager.pullBatchWithLock(
        queue,
        count,
        lock.owner,
        timeoutMs ?? 0,
        lock.lockTtl
      );
      return jobs.map((job, index) => pulled(job, tokens[index]));
    }
    const jobs = await this.manager.pullBatch(queue, count, timeoutMs);
    return jobs.map((job) => pulled(job, null));
  }

  async ackJob(id: string, result?: unknown, token?: string) {
    await this.manager.ack(toJobId(id), result, token);
  }

  async ackJobBatch(ids: string[], tokens?: string[]) {
    await this.manager.ackBatch(ids.map(toJobId), tokens);
  }

  async failJob(id: string, error?: string, opts?: FailJobOptions) {
    await this.manager.fail(toJobId(id), error, opts?.token, opts?.unrecoverable ?? false);
  }

  jobHeartbeat(id: string, token?: string) {
    return Promise.resolve(this.manager.jobHeartbeat(toJobId(id), token));
  }

  jobHeartbeatBatch(ids: string[], tokens?: string[]) {
    return Promise.resolve(this.manager.jobHeartbeatBatch(ids.map(toJobId), tokens));
  }

  /** Progress of any existing job: live for an active job, stored for every other state. */
  async getProgress(id: string) {
    const jobId = toJobId(id);
    const live = this.manager.getProgress(jobId);
    if (live) return live;
    const job = await this.manager.getJob(jobId);
    return job ? { progress: job.progress, message: job.progressMessage ?? null } : null;
  }

  changeDelay(id: string, delay: number) {
    return Promise.resolve(this.manager.changeDelay(toJobId(id), delay));
  }

  extendLock(id: string, token: string, duration: number) {
    return Promise.resolve(this.manager.extendLock(toJobId(id), token, duration));
  }
}
