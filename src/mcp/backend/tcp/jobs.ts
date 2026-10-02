import type {
  FailJobOptions,
  McpBulkJob,
  McpJobOptions,
  PulledJob,
  PullLockOptions,
} from '../../types/adapter';
import { toBulkJobInput, toPushFields } from '../jobOptions';
import { TcpBackendBase } from './base';
import { isNegativeOutcome, numberField, replyData } from './wire';

/** PULL/PULLB lock fields: an owner makes the broker issue a lock token. */
function lockFields(lock: PullLockOptions | undefined): Record<string, unknown> {
  if (!lock) return {};
  return lock.lockTtl === undefined
    ? { owner: lock.owner }
    : { owner: lock.owner, lockTtl: lock.lockTtl };
}

/** Attaches a lock token only when the broker issued one (a non-empty string). */
function withToken(job: PulledJob, token: unknown): PulledJob {
  if (typeof token === 'string' && token.length > 0) job.token = token;
  return job;
}

export class TcpJobBackend extends TcpBackendBase {
  async addJob(queue: string, name: string, data: unknown, opts?: McpJobOptions) {
    const response = await this.send({ cmd: 'PUSH', queue, name, data, ...toPushFields(opts) });
    const id = response.id;
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new Error('Invalid PUSH response from broker: missing job id');
    }
    return { jobId: String(id) };
  }

  async addJobsBulk(queue: string, jobs: McpBulkJob[]) {
    const response = await this.send({ cmd: 'PUSHB', queue, jobs: jobs.map(toBulkJobInput) });
    if (!Array.isArray(response.ids)) {
      throw new Error('Invalid PUSHB response from broker: missing job ids');
    }
    return { jobIds: (response.ids as unknown[]).map(String) };
  }

  /** null when the job does not exist (the broker replies "Job not found"). */
  async getJob(id: string) {
    return this.parseReplyJob(await this.sendLookup({ cmd: 'GetJob', id }));
  }

  async getJobState(id: string) {
    const response = await this.send({ cmd: 'GetState', id });
    return (response.state as string) ?? 'unknown';
  }

  async getJobResult(id: string) {
    return (await this.send({ cmd: 'GetResult', id })).result;
  }

  cancelJob(id: string) {
    return this.sendFlag({ cmd: 'Cancel', id });
  }

  promoteJob(id: string) {
    return this.sendFlag({ cmd: 'Promote', id });
  }

  updateProgress(id: string, progress: number, message?: string) {
    return this.sendFlag({ cmd: 'Progress', id, progress, message });
  }

  updateJobData(id: string, data: unknown) {
    return this.sendFlag({ cmd: 'Update', id, data });
  }

  changeJobPriority(id: string, priority: number) {
    return this.sendFlag({ cmd: 'ChangePriority', id, priority });
  }

  moveToDelayed(id: string, delay: number) {
    return this.sendFlag({ cmd: 'MoveToDelayed', id, delay });
  }

  discardJob(id: string) {
    return this.sendFlag({ cmd: 'Discard', id });
  }

  async getChildrenValues(parentJobId: string) {
    const response = await this.send({ cmd: 'GetChildrenValues', id: parentJobId });
    return (replyData(response).values ?? {}) as Record<string, unknown>;
  }

  /** null when no job has this custom id (the broker replies "Job not found"). */
  async getJobByCustomId(customId: string) {
    const job = this.parseReplyJob(await this.sendLookup({ cmd: 'GetJobByCustomId', customId }));
    // GetJobByCustomId does not report the state; resolve it like GetJob does.
    if (job && job.state === undefined) job.state = await this.getJobState(job.id);
    return job;
  }

  async waitForJobCompletion(id: string, timeoutMs: number) {
    const response = await this.send({ cmd: 'WaitJob', id, timeout: timeoutMs });
    return response.completed === true;
  }

  /**
   * GetProgress only answers for jobs that are still tracked as in flight; for any other
   * existing job (e.g. completed at 100) the stored progress comes from GetJob. null only
   * when the job does not exist.
   */
  async getProgress(id: string) {
    try {
      const response = await this.send({ cmd: 'GetProgress', id });
      return {
        progress: numberField(response, 'progress'),
        message: typeof response.message === 'string' ? response.message : null,
      };
    } catch (error) {
      if (!isNegativeOutcome(error)) throw error;
    }
    const job = (await this.sendLookup({ cmd: 'GetJob', id }))?.job as
      | Record<string, unknown>
      | null
      | undefined;
    if (!job || typeof job !== 'object') return null;
    return {
      progress: numberField(job, 'progress'),
      message: typeof job.progressMessage === 'string' ? job.progressMessage : null,
    };
  }

  changeDelay(id: string, delay: number) {
    return this.sendFlag({ cmd: 'ChangeDelay', id, delay });
  }

  extendLock(id: string, token: string, duration: number) {
    return this.sendFlag({ cmd: 'ExtendLock', id, token, duration });
  }

  /** With `lock`, the broker locks the job and replies with its token next to it. */
  async pullJob(queue: string, timeoutMs?: number, lock?: PullLockOptions) {
    const response = await this.send({
      cmd: 'PULL',
      queue,
      timeout: timeoutMs,
      ...lockFields(lock),
    });
    const job = this.parseReplyJob(response, 'active');
    return job ? withToken(job, lock ? response.token : undefined) : null;
  }

  async pullJobBatch(queue: string, count: number, timeoutMs?: number, lock?: PullLockOptions) {
    const response = await this.send({
      cmd: 'PULLB',
      queue,
      count,
      timeout: timeoutMs,
      ...lockFields(lock),
    });
    const tokens = lock && Array.isArray(response.tokens) ? (response.tokens as unknown[]) : [];
    return ((response.jobs as Array<Record<string, unknown>>) ?? []).map((job, index) =>
      withToken(this.parseJob(job, 'active'), tokens[index])
    );
  }

  async ackJob(id: string, result?: unknown, token?: string) {
    await this.send({ cmd: 'ACK', id, result, ...(token === undefined ? {} : { token }) });
  }

  async ackJobBatch(ids: string[], tokens?: string[]) {
    await this.send({ cmd: 'ACKB', ids, ...(tokens === undefined ? {} : { tokens }) });
  }

  async failJob(id: string, error?: string, opts?: FailJobOptions) {
    await this.send({
      cmd: 'FAIL',
      id,
      error,
      ...(opts?.token === undefined ? {} : { token: opts.token }),
      ...(opts?.unrecoverable === undefined ? {} : { unrecoverable: opts.unrecoverable }),
    });
  }

  jobHeartbeat(id: string, token?: string) {
    return this.sendFlag({ cmd: 'JobHeartbeat', id, ...(token === undefined ? {} : { token }) });
  }

  async jobHeartbeatBatch(ids: string[], tokens?: string[]) {
    const response = await this.send({
      cmd: 'JobHeartbeatB',
      ids,
      ...(tokens === undefined ? {} : { tokens }),
    });
    return numberField(replyData(response), 'count');
  }
}
