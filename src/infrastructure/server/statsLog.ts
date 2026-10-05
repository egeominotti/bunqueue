/**
 * The periodic "Queue statistics" server log line.
 *
 * Armed with `safeInterval`: the period is the validated `statsIntervalMs` (a whole
 * number >= 1000 ms, see src/config/settings.ts), and a period above the native timer
 * limit (2^31 - 1 ms) is honoured instead of being rewritten to a 1 ms spin.
 */

import type { QueueManager } from '../../application/queueManager';
import { statsLog } from '../../shared/logger';
import { safeInterval, type SafeTimer } from '../../shared/timers';

/** Connection counters of the running TCP and HTTP servers. */
export interface StatsConnections {
  readonly tcp: () => number;
  readonly ws: () => number;
  readonly sse: () => number;
}

/** Log queue, connection and memory statistics every `periodMs`. */
export function startStatsLog(
  queueManager: QueueManager,
  connections: StatsConnections,
  periodMs: number
): SafeTimer {
  return safeInterval(() => {
    const stats = queueManager.getStats();
    const memStats = queueManager.getMemoryStats();
    const workerStats = queueManager.workerManager.getStats();
    const mem = process.memoryUsage();
    const timestamp = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    statsLog.info('Queue statistics', {
      time: timestamp,
      waiting: stats.waiting,
      active: stats.active,
      delayed: stats.delayed,
      completed: stats.completed,
      dlq: stats.dlq,
      tcp: connections.tcp(),
      ws: connections.ws(),
      sse: connections.sse(),
      workers: `${workerStats.active}/${workerStats.total}`,
      mem: `${Math.round(mem.heapUsed / 1024 / 1024)}MB/${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
      rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
      // Internal collection sizes (for memory debugging)
      idx: memStats.jobIndex,
      locks: memStats.jobLocks,
      clients: memStats.clientJobsTotal,
    });
  }, periodMs);
}
