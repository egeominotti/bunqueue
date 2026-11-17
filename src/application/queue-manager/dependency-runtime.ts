import type { JobId } from '../../domain/types/job';
import { processPendingDependencies } from '../dependencyProcessor';
import { handleTaskError, handleTaskSuccess } from '../taskErrorTracking';
import { QueueManagerServices } from './services';

export class QueueManagerDependencyRuntime extends QueueManagerServices {
  protected onJobsCompleted(completedIds: JobId[]): void {
    for (const id of completedIds) this.pendingDepChecks.add(id);
    this.scheduleDependencyFlush();
  }

  protected scheduleDependencyFlush(): void {
    if (this.depFlushScheduled) return;
    this.depFlushScheduled = true;
    queueMicrotask(() => {
      this.depFlushScheduled = false;
      if (!this.depFlushRunning) void this.runDependencyFlush();
    });
  }

  protected async runDependencyFlush(): Promise<void> {
    this.depFlushRunning = true;
    try {
      while (this.pendingDepChecks.size > 0) {
        await processPendingDependencies(this.contextFactory.getBackgroundContext());
        handleTaskSuccess('dependency');
      }
    } catch (error) {
      // A failed wave keeps its notifications for the next completion or fallback interval.
      // Immediately enqueuing another microtask would spin on persistent storage failures.
      handleTaskError('dependency', error);
    } finally {
      this.depFlushRunning = false;
    }
  }

  protected hasPendingDeps(): boolean {
    return this.shards.some((shard) => shard.waitingDeps.size > 0);
  }
}
