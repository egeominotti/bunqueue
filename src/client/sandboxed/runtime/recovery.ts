import { jobId, type Job as DomainJob } from '../../../domain/types/job';
import { safeInterval } from '../../../shared/timers';
import { getSharedManager } from '../../manager';
import { createPublicJob } from '../../jobConversion';
import { buildFailCommand, failEmbeddedArgs } from '../../queue/failWire';
import type { Job } from '../../types';
import {
  createChangeDelayHandler,
  createChangePriorityHandler,
  createClearLogsHandler,
  createDiscardHandler,
  createExtendLockHandler,
  createGetChildrenValuesHandler,
  createGetDependenciesCountHandler,
  createGetDependenciesHandler,
  createGetFailedChildrenValuesHandler,
  createGetIgnoredChildrenFailuresHandler,
  createGetStateHandler,
  createLogHandler,
  createMoveToDelayedHandler,
  createMoveToWaitHandler,
  createMoveToWaitingChildrenHandler,
  createProgressHandler,
  createPromoteHandler,
  createRemoveChildDependencyHandler,
  createRemoveDeduplicationKeyHandler,
  createRemoveHandler,
  createRemoveUnprocessedChildrenHandler,
  createRetryHandler,
  createUpdateDataHandler,
  createWaitUntilFinishedHandler,
} from '../../worker/processorHandlers';
import type { WorkerProcess } from '../types';
import { SandboxedDispatch } from './dispatch';
import { log } from './log';

export class SandboxedRecovery<T = unknown> extends SandboxedDispatch<T> {
  /**
   * A thread died: an uncaught error, an exit, a processor module that failed to load,
   * or a job timeout that terminated it. Handled once per thread. Its job is failed at
   * once (retried per its attempts), never left holding its lease. Within the restart
   * budget (`autoRestart`, and the counter, incremented first, below `maxRestarts`) the
   * slot gets a new thread, given jobs only once its processor has loaded; otherwise it
   * is retired: never respawned, never given a job. The pull loop stops the worker when
   * every slot is retired (`stopExhausted`).
   */
  protected handleCrash(worker: WorkerProcess, reason: string, reportError = true): void {
    const index = this.workers.indexOf(worker);
    if (index === -1 || worker.crashed) return;
    worker.crashed = true;
    worker.terminated = true;
    // A thread that raised an error may still run: nothing more of it is wanted.
    worker.worker.terminate();
    const message = `Worker crashed: ${reason}`;
    if (worker.currentJob) void this.fail(worker, message);
    else this.resetWorkerState(worker);
    if (reportError) {
      this.safeEmitError(
        Object.assign(new Error(message), { workerIndex: index, context: 'crash' as const })
      );
    }
    worker.restarts++;
    if (!this.running) return;
    if (this.options.autoRestart && worker.restarts < this.options.maxRestarts) {
      this.spawnWorker(index).catch((error: unknown) => {
        // A new thread that dies while loading is handled as its own crash; one that a
        // stop() terminated while it loaded is no failure to report.
        if (!this.running) return;
        log('error', 'Failed to restart worker', {
          workerIndex: index,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    worker.retired = true;
    log('error', 'Sandbox thread retired', {
      workerIndex: index,
      restarts: worker.restarts,
      maxRestarts: this.options.maxRestarts,
      autoRestart: this.options.autoRestart,
    });
    // A pull loop waiting for a free thread re-checks now, so it never pulls for none.
    this.wakePullLoop();
  }

  /**
   * Every thread crashed and none may restart: report it (`error`, context
   * 'exhausted') and stop as stop() would, `autoStart` included, since an automatic
   * restart would crash again. A later start() begins with a fresh restart budget.
   */
  protected stopExhausted(): void {
    const cause = this.options.autoRestart
      ? `maxRestarts (${this.options.maxRestarts}) is used up`
      : 'autoRestart is off';
    const error = Object.assign(
      new Error(
        `SandboxedWorker: all ${this.workers.length} threads crashed and ${cause}; the worker stopped`
      ),
      { queue: this.queueName, context: 'exhausted' as const }
    );
    log('error', error.message, { queue: this.queueName });
    this.safeEmitError(error);
    this.idleStop().catch((failure: unknown) => {
      log('error', 'Exhausted-pool stop failed', {
        queue: this.queueName,
        error: failure instanceof Error ? failure.message : String(failure),
      });
    });
  }

  protected startHeartbeat(): void {
    // 0 = disabled; otherwise a finite period >= 1 ms by construction. safeInterval
    // honours one above the 2^31 - 1 ms native limit instead of spinning.
    if (this.heartbeatInterval <= 0) return;
    this.heartbeatTimer?.clear();
    this.heartbeatTimer = safeInterval(() => void this.sendHeartbeat(), this.heartbeatInterval);
  }

  protected async sendHeartbeat(): Promise<void> {
    const active = this.workers.filter(
      (worker) => worker.busy && worker.currentJob && !worker.terminated
    );
    if (active.length === 0) return;
    try {
      const ids = active.map((worker) => String(worker.currentJob?.id));
      const tokens = active.map((worker) => worker.currentToken ?? '');
      await this.ops.sendHeartbeat(ids, tokens);
    } catch (error) {
      this.safeEmitError(
        Object.assign(error instanceof Error ? error : new Error(String(error)), {
          context: 'heartbeat' as const,
        })
      );
    }
  }

  protected safeEmitError(error: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  protected createEventJob(domainJob: DomainJob): Job {
    const embedded = !this.tcp;
    const tcp = this.tcp;
    const moveToCompleted = async (
      id: string,
      returnValue: unknown,
      token?: string
    ): Promise<unknown> => {
      if (embedded) await getSharedManager().ack(jobId(id), returnValue, token);
      else if (tcp) {
        const response = await tcp.send({
          cmd: 'ACK',
          id,
          result: returnValue,
          ...(token === undefined ? {} : { token }),
        });
        if (response.ok !== true) {
          throw new Error(typeof response.error === 'string' ? response.error : 'ACK failed');
        }
      }
      return null;
    };
    const moveToFailed = async (id: string, error: Error, token?: string): Promise<void> => {
      if (embedded) await getSharedManager().fail(jobId(id), ...failEmbeddedArgs(error, token));
      else if (tcp) await tcp.send(buildFailCommand(id, error, token));
    };
    return createPublicJob({
      job: domainJob,
      name: domainJob.name,
      updateProgress: createProgressHandler(embedded, tcp, this, { current: null }),
      log: createLogHandler(embedded, tcp, this, { current: null }),
      getState: createGetStateHandler(embedded, tcp),
      getChildrenValues: createGetChildrenValuesHandler(embedded, tcp),
      getFailedChildrenValues: createGetFailedChildrenValuesHandler(embedded, tcp),
      getIgnoredChildrenFailures: createGetIgnoredChildrenFailuresHandler(embedded, tcp),
      removeChildDependency: createRemoveChildDependencyHandler(embedded, tcp),
      removeUnprocessedChildren: createRemoveUnprocessedChildrenHandler(embedded, tcp),
      remove: createRemoveHandler(embedded, tcp),
      retry: createRetryHandler(embedded, tcp, { internalJob: domainJob }),
      updateData: createUpdateDataHandler(embedded, tcp),
      promote: createPromoteHandler(embedded, tcp),
      changeDelay: createChangeDelayHandler(embedded, tcp),
      changePriority: createChangePriorityHandler(embedded, tcp),
      extendLock: createExtendLockHandler(embedded, tcp),
      clearLogs: createClearLogsHandler(embedded, tcp),
      moveToWait: createMoveToWaitHandler(embedded, tcp),
      moveToDelayed: createMoveToDelayedHandler(embedded, tcp),
      moveToWaitingChildren: createMoveToWaitingChildrenHandler(embedded, tcp),
      waitUntilFinished: createWaitUntilFinishedHandler(embedded, tcp),
      discard: createDiscardHandler(embedded, tcp),
      getDependencies: createGetDependenciesHandler(embedded, tcp, domainJob),
      getDependenciesCount: createGetDependenciesCountHandler(embedded, tcp, domainJob),
      removeDeduplicationKey: createRemoveDeduplicationKeyHandler(embedded, tcp),
      moveToCompleted,
      moveToFailed,
    });
  }
}
