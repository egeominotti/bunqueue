import type { CronScheduler } from '../../infrastructure/scheduler/cronScheduler';
import type { JobId } from '../../domain/types/job';
import type { SafeTimer } from '../../shared/timers';
import type { JobTimeoutScheduler } from '../background/timeouts';

/** A processing generation whose timeout transition won before its worker outcome. */
export interface RetiredTimeoutGeneration {
  readonly jobId: JobId;
  readonly startedAt: number;
  readonly token?: string;
}

/** The periodic background tasks; each interval is a `safeInterval`, stopped with clear(). */
export interface BackgroundTaskHandles {
  cleanupInterval: SafeTimer;
  timeoutScheduler: JobTimeoutScheduler;
  depCheckInterval: SafeTimer;
  stallCheckInterval: SafeTimer;
  dlqMaintenanceInterval: SafeTimer;
  lockCheckInterval: SafeTimer;
  cronScheduler: CronScheduler;
}
