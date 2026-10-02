import type { JobLogEntry } from '../../../domain/types/worker';
import { TcpQueueBackend } from './queues';
import { replyData } from './wire';

/** Totals the broker's Metrics reply adds to the Stats reply. */
const METRIC_TOTALS = [
  'totalPushed',
  'totalPulled',
  'totalCompleted',
  'totalFailed',
  'avgLatencyMs',
  'avgProcessingMs',
  'memoryUsageMb',
] as const;

/** Stats, metrics, memory, storage and job logs over TCP. */
export class TcpMonitoringBackend extends TcpQueueBackend {
  /**
   * Broker-wide stats without the wire envelope: the Stats reply's `stats` object
   * (waiting, active, delayed, dlq, completed, failed, uptime, push/pull rates) plus
   * the lifetime totals and averages from the Metrics reply.
   */
  async getStats(): Promise<Record<string, unknown>> {
    const [statsReply, metricsReply] = await Promise.all([
      this.send({ cmd: 'Stats' }),
      this.send({ cmd: 'Metrics' }),
    ]);
    const stats = statsReply.stats;
    if (stats === null || typeof stats !== 'object') {
      throw new Error('Invalid Stats response from broker');
    }
    const result: Record<string, unknown> = { ...(stats as Record<string, unknown>) };
    const metrics = metricsReply.metrics as Record<string, unknown> | undefined;
    for (const key of METRIC_TOTALS) {
      if (typeof metrics?.[key] === 'number') result[key] = metrics[key];
    }
    return result;
  }

  async getPerQueueStats(): Promise<Record<string, unknown>> {
    const response = await this.send({ cmd: 'DashboardQueues' });
    const queues = replyData(response).queues as Array<Record<string, unknown>> | undefined;
    const result: Record<string, unknown> = {};
    for (const queue of queues ?? []) {
      const name = queue.name;
      if (typeof name !== 'string') continue;
      result[name] = {
        waiting: (queue.waiting as number) ?? 0,
        prioritized: (queue.prioritized as number) ?? 0,
        delayed: (queue.delayed as number) ?? 0,
        active: (queue.active as number) ?? 0,
        dlq: (queue.dlq as number) ?? 0,
      };
    }
    return result;
  }

  /**
   * The broker's in-memory collection sizes (jobIndex, completedJobs, ...). No dedicated
   * command exists; DashboardOverview carries them as `collections`.
   */
  async getMemoryStats(): Promise<Record<string, unknown>> {
    const response = await this.send({ cmd: 'DashboardOverview' });
    const collections = replyData(response).collections;
    if (collections === null || typeof collections !== 'object') {
      throw new Error('Invalid DashboardOverview response from broker: missing collections');
    }
    return collections as Record<string, unknown>;
  }

  async getPrometheusMetrics() {
    const metrics = replyData(await this.send({ cmd: 'Prometheus' })).metrics;
    if (typeof metrics !== 'string') {
      throw new Error('Invalid Prometheus response from broker: missing metrics');
    }
    return metrics;
  }

  async getStorageStatus() {
    const data = replyData(await this.send({ cmd: 'StorageStatus' }));
    return {
      diskFull: (data.diskFull as boolean) ?? false,
      error: (data.error as string | null) ?? null,
    };
  }

  async getJobLogs(id: string): Promise<JobLogEntry[]> {
    const logs = replyData(await this.send({ cmd: 'GetLogs', id })).logs;
    return Array.isArray(logs) ? (logs as JobLogEntry[]) : [];
  }

  addJobLog(id: string, message: string, level?: 'info' | 'warn' | 'error') {
    return this.sendFlag({ cmd: 'AddLog', id, message, level });
  }

  async clearJobLogs(id: string, keepLogs?: number) {
    await this.send({ cmd: 'ClearLogs', id, keepLogs });
  }

  async compactMemory() {
    await this.send({ cmd: 'CompactMemory' });
  }
}
