import { jobId } from '../../../domain/types/job';
import { getSharedManager } from '../../manager';
import { WorkerManual } from './manual';
import type { WorkerDelivery } from './state';

export abstract class WorkerLifecycle<T = unknown, R = unknown> extends WorkerManual<T, R> {
  private returningBatches = 0;

  async close(force = false): Promise<void> {
    if (this.closed) return;
    if (force) {
      this._forceClose = true;
      this.stopHeartbeats();
    }
    this._closingPromise ??= this._doClose();
    return this._closingPromise;
  }

  private stopHeartbeats(): void {
    this.stopJobHeartbeat();
    this.workerHeartbeatTimer?.clear();
    this.workerHeartbeatTimer = null;
  }

  protected async _doClose(): Promise<void> {
    this._closing = true;
    this.running = false;
    this.paused = false;
    this.clearPollTimer();
    this.ackBatcher.notifyCapacityChanged();
    this.pendingJobs = [];
    this.pendingJobsHead = 0;

    await this.releaseUnstartedJobs([...this.currentDeliveries.values()]);
    while (this.activeJobs > 0 && !this._forceClose) await Bun.sleep(50);

    await this.ackBatcher.flush();
    await this.ackBatcher.waitForInFlight();
    this.ackBatcher.stop();
    this.stopHeartbeats();

    if (this.registered) {
      if (this.embedded) {
        getSharedManager().unregisterWorker(this.workerId);
      } else if (this.tcp) {
        try {
          await this.tcp.send({ cmd: 'UnregisterWorker', workerId: this.workerId });
        } catch {
          // Best-effort unregister — server will cleanup via stale timeout.
        }
      }
      this.registered = false;
    }

    await Bun.sleep(100);
    // An unanswered TCP long poll is cancelled by closing its connection. Finish
    // returning any deliveries we already received before closing that connection.
    // Embedded pulls have no disconnect recovery and must finish handing back jobs.
    while (this.returningBatches > 0 || (this.embedded && this.pendingPull > 0)) {
      await Bun.sleep(10);
    }
    if (this.stalledUnsubscribe) {
      this.stalledUnsubscribe();
      this.stalledUnsubscribe = null;
    }

    this.clearDeliveries();
    this.pulledJobIds.clear();
    this.jobTokens.clear();
    this.cancelledJobs.clear();
    if (this.groupLimiter) this.groupLimiter.clear();

    if (this.tcpPool) this.tcpPool.close();
    this.closed = true;
    this._closing = false;
    this.emit('closed');
  }

  protected async releaseUnstartedJobs(deliveries: WorkerDelivery[]): Promise<void> {
    this.returningBatches++;
    try {
      for (const delivery of deliveries) {
        if (this.isCurrentDelivery(delivery) && !this.isActiveDelivery(delivery)) {
          await this.releasePulledJob(delivery);
        }
      }
    } finally {
      this.returningBatches--;
    }
  }

  private async releasePulledJob(delivery: WorkerDelivery): Promise<void> {
    const id = String(delivery.job.id);
    const { token } = delivery;
    try {
      if (this.embedded) {
        const manager = getSharedManager();
        await manager.moveActiveToWait(jobId(id), token ?? undefined);
      } else if (this.tcp) {
        await this.tcp.send({
          cmd: 'MoveToWait',
          id,
          ...(token ? { token } : {}),
        });
      }
    } catch {
      // Lock expiration recovers anything that could not be released.
    } finally {
      this.forgetDelivery(delivery);
    }
  }
}
