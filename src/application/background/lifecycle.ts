import type { CronScheduler } from '../../infrastructure/scheduler/cronScheduler';
import { cleanup } from '../cleanupTasks';
import { processPendingDependencies } from '../dependencyProcessor';
import { checkExpiredLocks } from '../lockManager';
import { runMonitoringChecks } from '../monitoringChecks';
import { checkStalledJobs } from '../stallDetection';
import { handleTaskError, handleTaskSuccess } from '../taskErrorTracking';
import type { BackgroundContext, BackgroundTaskHandles, LockContext } from '../types';
import { safeInterval, type SafeTimer } from '../../shared/timers';
import { performDlqMaintenance } from './dlq';

function getLockContext(ctx: BackgroundContext): LockContext {
  return {
    jobIndex: ctx.jobIndex,
    jobLocks: ctx.jobLocks,
    retiredCronLeaseTokens: ctx.retiredCronLeaseTokens,
    clientJobs: ctx.clientJobs,
    clientJobOwners: ctx.clientJobOwners,
    processingShards: ctx.processingShards,
    processingLocks: ctx.processingLocks,
    shards: ctx.shards,
    shardLocks: ctx.shardLocks,
    eventsManager: ctx.eventsManager,
    dashboardEmit: ctx.dashboardEmit,
    storage: ctx.storage,
    timeoutScheduler: ctx.timeoutScheduler,
  };
}

export function startBackgroundTasks(
  ctx: BackgroundContext,
  cronScheduler: CronScheduler
): BackgroundTaskHandles {
  const timeoutScheduler = ctx.timeoutScheduler;
  const intervals: SafeTimer[] = [];
  try {
    const cleanupInterval = safeInterval(() => {
      cleanup(ctx)
        .then(() => {
          handleTaskSuccess('cleanup');
          runMonitoringChecks({
            queueNamesCache: ctx.queueNamesCache,
            shards: ctx.shards,
            processingShards: ctx.processingShards,
            workerManager: ctx.workerManager,
            storage: ctx.storage,
            dashboardEmit: ctx.dashboardEmit,
            state: ctx.monitoringState,
          });
        })
        .catch((error: unknown) => {
          handleTaskError('cleanup', error);
        });
    }, ctx.config.cleanupIntervalMs);
    intervals.push(cleanupInterval);

    timeoutScheduler.start(ctx);
    const depCheckInterval = safeInterval(() => {
      if (ctx.pendingDepChecks.size === 0) return;
      processPendingDependencies(ctx)
        .then(() => handleTaskSuccess('dependency'))
        .catch((error: unknown) => handleTaskError('dependency', error));
    }, ctx.config.dependencyCheckMs);
    intervals.push(depCheckInterval);

    const stallCheckInterval = safeInterval(() => checkStalledJobs(ctx), ctx.config.stallCheckMs);
    intervals.push(stallCheckInterval);
    const dlqMaintenanceInterval = safeInterval(
      () => performDlqMaintenance(ctx),
      ctx.config.dlqMaintenanceMs
    );
    intervals.push(dlqMaintenanceInterval);
    const lockCheckInterval = safeInterval(() => {
      checkExpiredLocks(getLockContext(ctx))
        .then(() => handleTaskSuccess('lockExpiration'))
        .catch((error: unknown) => handleTaskError('lockExpiration', error));
    }, ctx.config.stallCheckMs);
    intervals.push(lockCheckInterval);

    cronScheduler.start();
    return {
      cleanupInterval,
      timeoutScheduler,
      depCheckInterval,
      stallCheckInterval,
      dlqMaintenanceInterval,
      lockCheckInterval,
      cronScheduler,
    };
  } catch (error) {
    for (const interval of intervals) interval.clear();
    timeoutScheduler.stop();
    cronScheduler.stop();
    throw error;
  }
}

export function stopBackgroundTasks(handles: BackgroundTaskHandles): void {
  handles.cleanupInterval.clear();
  handles.timeoutScheduler.stop();
  handles.depCheckInterval.clear();
  handles.stallCheckInterval.clear();
  handles.dlqMaintenanceInterval.clear();
  handles.lockCheckInterval.clear();
  handles.cronScheduler.stop();
}
