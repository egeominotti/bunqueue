/**
 * Queue counts and job logs. Methods are merged onto Queue.prototype by queue.ts
 * (split out of queue-query.ts to keep each area module small).
 */

import { compact } from './frame.js';
import type { Queue } from './queue.js';
import type { CountResponse, JobCountsResponse } from './responses.js';
import type { JobCounts } from './types.js';

type Ctx = Queue<unknown>;
type Raw = Record<string, unknown>;

export const countMethods = {
  // ------------------------------------------------------------------- counts

  async getJobCounts(this: Ctx): Promise<JobCounts> {
    return (await this.call<JobCountsResponse>({ cmd: 'GetJobCounts', queue: this.name })).counts;
  },

  async getWaitingCount(this: Ctx): Promise<number> {
    // 'waiting' only — prioritized jobs are counted by getPrioritizedCount,
    // matching BullMQ and the Python SDK / reference client.
    return (await this.getJobCounts()).waiting;
  },

  async getActiveCount(this: Ctx): Promise<number> {
    return (await this.getJobCounts()).active;
  },

  async getCompletedCount(this: Ctx): Promise<number> {
    return (await this.getJobCounts()).completed;
  },

  async getFailedCount(this: Ctx): Promise<number> {
    return (await this.getJobCounts()).failed;
  },

  async getDelayedCount(this: Ctx): Promise<number> {
    return (await this.getJobCounts()).delayed;
  },

  async getPrioritizedCount(this: Ctx): Promise<number> {
    return (await this.getJobCounts()).prioritized;
  },

  async getWaitingChildrenCount(this: Ctx): Promise<number> {
    return (await this.getJobCounts())['waiting-children'];
  },

  async count(this: Ctx): Promise<number> {
    return (await this.call<CountResponse>({ cmd: 'Count', queue: this.name })).count ?? 0;
  },

  async getCountsPerPriority(this: Ctx): Promise<Record<string, number>> {
    const response = await this.call({ cmd: 'GetCountsPerPriority', queue: this.name });
    return (response.counts ?? response.data ?? {}) as Record<string, number>;
  },

  // --------------------------------------------------------------------- logs

  async addJobLog(
    this: Ctx,
    id: string,
    message: string,
    level?: 'info' | 'warn' | 'error'
  ): Promise<void> {
    await this.call(compact({ cmd: 'AddLog', id, message, level }) as { cmd: string });
  },

  async getJobLogs(this: Ctx, id: string, start?: number, end?: number): Promise<string[]> {
    const response = await this.call(
      compact({ cmd: 'GetLogs', id, start, end }) as {
        cmd: string;
      }
    );
    const data = (response.data ?? {}) as Raw;
    const logs = (data.logs ?? response.logs ?? []) as unknown[];
    // Format as `[level] message` (reference client parity); never drop level.
    return logs.map((row) => {
      if (typeof row === 'string') return row;
      const r = row as Raw;
      return r.level ? `[${r.level}] ${r.message}` : String(r.message ?? row);
    });
  },

  async clearJobLogs(this: Ctx, id: string, keepLogs?: number): Promise<void> {
    await this.call(compact({ cmd: 'ClearLogs', id, keepLogs }) as { cmd: string });
  },
};

export type QueueCountsApi = typeof countMethods;
