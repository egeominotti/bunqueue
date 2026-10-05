import type { Job as DomainJob } from '../../../domain/types/job';
import { safeTimeout, type SafeTimer } from '../../../shared/timers';
import { WORKER_CONSTANTS } from '../../worker/constants';
import { PullFailureLog, QUIET_PULL, quietPullOrThrow } from '../../worker/pullFailureLog';
import type { IPCResponse, WorkerProcess } from '../types';
import { SandboxedLifecycle } from './lifecycle';
import { log } from './log';
import { READY_TIMEOUT_MS, type ThreadEvents, watchThread } from './thread';

/** Where a pull-loop pass failed, and the job it had pulled but not dispatched. */
interface PullStep {
  stage: 'spawn' | 'pull';
  job: DomainJob | null;
  token: string | null;
}

/** Running and still loading its processor: posts `ready` (or dies) next. */
function isLoading(worker: WorkerProcess): boolean {
  return worker.loading === true && !worker.terminated;
}

/** Running, loaded and without a job: the only thread a job may be posted to. */
function isIdle(worker: WorkerProcess): boolean {
  return !worker.busy && !worker.terminated && worker.loading !== true;
}

export abstract class SandboxedPool<T = unknown> extends SandboxedLifecycle<T> {
  /** The pull loop's pending wait (pollInterval or an error backoff), if any. */
  private pollWait: { timer: SafeTimer; resume: () => void } | null = null;
  /** Consecutive failed passes of the pull loop; an answered pull resets it. */
  private pullErrors = 0;
  /** Rate limit of the console line for pull failures nobody listens to. */
  private readonly pullFailureLog = new PullFailureLog();

  /**
   * Start a thread in slot `index`, replacing the slot's previous thread record. The
   * record is `loading`, given no job, until the thread posts `ready`; the promise is
   * watchThread's (ready, at most READY_TIMEOUT_MS, or a rejection if it dies first).
   */
  protected spawnWorker(index: number): Promise<void> {
    if (!this.wrapperPath) return Promise.resolve();
    const worker = new Worker(this.wrapperPath, { smol: this.options.maxMemory <= 64 });
    const workerProcess: WorkerProcess = {
      worker,
      busy: false,
      currentJob: null,
      currentToken: null,
      restarts: this.workers[index]?.restarts ?? 0,
      timeoutId: null,
      lastIdleAt: Date.now(),
      terminated: false,
      crashed: false,
      retired: false,
      loading: true,
    };
    if (this.workers[index]) this.workers[index] = workerProcess;
    else this.workers.push(workerProcess);
    return watchThread(worker as unknown as ThreadEvents, workerProcess, {
      workerIndex: index,
      onMessage: (message) => this.handleMessage(workerProcess, message),
      onDeath: (reason) => this.handleCrash(workerProcess, reason),
    });
  }

  /**
   * Pull and dispatch until stopped. A failed pass (a rejected or refused pull, a
   * thread that fails to respawn) never ends the loop: as the Worker's pull loop does,
   * it waits 100 ms doubling to 30 s before the next pass and reports `error`
   * (`context` 'pull' or 'spawn', `queue`, `consecutiveErrors`). stop() ends that wait
   * at once. See `reportLoopError` for who hears the report.
   */
  protected async pullLoop(): Promise<void> {
    while (this.running) {
      const step: PullStep = { stage: 'spawn', job: null, token: null };
      try {
        if (await this.pullOnce(step)) return;
      } catch (error) {
        await this.recoverPullLoop(error, step);
      }
    }
  }

  /**
   * One pass of the pull loop; true when the loop ends (an idle stop took over, or
   * every thread is retired). It pulls only for a thread that is loaded and idle.
   */
  private async pullOnce(step: PullStep): Promise<boolean> {
    const idle = this.liveIdleThread();
    if (!idle) return this.awaitThread();

    step.stage = 'pull';
    const pulled = await this.ops.pull(this.queueName, this.workerId, 1000).catch(quietPullOrThrow);
    // An answered pull, even an empty or transiently refused one, ends a failure streak.
    this.pullErrors = 0;
    if (pulled === QUIET_PULL) {
      // As an empty pull (2.9.10 read it as one), then pollInterval: 2.9.10 re-pulled at
      // once, a request flood against a rate-limiting broker.
      if (this.afterEmptyPull()) return true;
      await this.waitPull(this.options.pollInterval);
      return false;
    }
    const { job, token } = pulled;
    if (!job) return this.afterEmptyPull();

    step.stage = 'spawn';
    step.job = job;
    step.token = token;
    const thread = await this.threadForJob(idle);
    step.job = null;
    this.dispatch(thread, job, token);
    return false;
  }

  /** An idle thread that is running and has loaded its processor, to pull a job for. */
  private liveIdleThread(): WorkerProcess | undefined {
    return this.workers.find((worker) => isIdle(worker));
  }

  /**
   * No thread can take a job now. Respawn a recycled slot (pulled for on a later pass,
   * once its processor has loaded), stop when every thread is retired, or wait
   * pollInterval: for a busy thread to finish or a new one to load.
   */
  private async awaitThread(): Promise<boolean> {
    const recycled = this.recyclableSlot();
    if (recycled) {
      await this.respawn(recycled);
      return false;
    }
    // Every thread crashed beyond its restart budget: pull nothing it cannot run.
    if (this.workers.length > 0 && this.workers.every((worker) => worker.retired)) {
      this.stopExhausted();
      return true;
    }
    await this.waitPull(this.options.pollInterval);
    return false;
  }

  /** A recycled slot that may be respawned: never a retired one, nor one still settling. */
  private recyclableSlot(): WorkerProcess | undefined {
    return this.workers.find((worker) => worker.terminated && !worker.retired && !worker.busy);
  }

  /**
   * The thread for a job just pulled for `preferred`. That thread may have died during
   * the pull, its slot then restarting (a new thread still loading) or retired. Then
   * another loaded idle thread, or one that finishes loading (a recyclable slot is
   * respawned) within READY_TIMEOUT_MS. With none, the job is failed, not left leased.
   */
  private async threadForJob(preferred: WorkerProcess): Promise<WorkerProcess> {
    if (!preferred.terminated) return preferred;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const other = this.liveIdleThread();
      if (other) return other;
      const slot = this.recyclableSlot();
      if (slot) {
        await this.respawn(slot);
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !this.workers.some((worker) => isLoading(worker))) break;
      await this.waitPull(Math.min(this.options.pollInterval, remaining));
    }
    throw new Error('no live sandbox thread to run it');
  }

  /** Start a new thread in `worker`'s slot; it takes jobs once its processor loaded. */
  private respawn(worker: WorkerProcess): Promise<void> {
    return this.spawnWorker(this.workers.indexOf(worker));
  }

  /** Recycle spare threads and apply idleTimeout; true when an idle stop began. */
  private afterEmptyPull(): boolean {
    this.recycleIdleWorkers();
    if (this.idleTimeout <= 0 || Date.now() - this.lastActivityTime < this.idleTimeout) {
      return false;
    }
    const idleStop = this.autoStart ? this.stopAndWatch() : this.idleStop();
    idleStop.catch((error: unknown) => {
      log('error', this.autoStart ? 'Idle stop-and-watch failed' : 'Idle timeout stop failed', {
        queue: this.queueName,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }

  private async recoverPullLoop(errorValue: unknown, step: PullStep): Promise<void> {
    const error = errorValue instanceof Error ? errorValue : new Error(String(errorValue));
    // A job pulled for a thread that failed to respawn must not keep its lease.
    if (step.job) {
      const id = step.job.id;
      this.ops
        .fail(id, `Dispatch failed: ${error.message}`, step.token ?? undefined)
        .catch((failure: unknown) => {
          log('error', 'Failed to mark undispatched job as failed', {
            jobId: String(id),
            error: failure instanceof Error ? failure.message : String(failure),
          });
        });
    }
    if (!this.running) return;
    this.pullErrors++;
    const backoff = Math.min(
      WORKER_CONSTANTS.BASE_BACKOFF_MS * 2 ** (this.pullErrors - 1),
      WORKER_CONSTANTS.MAX_BACKOFF_MS
    );
    // Arm the retry before reporting, so no report can end the loop.
    const retry = this.waitPull(backoff);
    this.reportLoopError(
      Object.assign(error, {
        queue: this.queueName,
        consecutiveErrors: this.pullErrors,
        context: step.stage,
      }),
      step.stage
    );
    await retry;
  }

  /**
   * Report a failed pass as Worker reports a failed pull (`PullFailureLog`): a transient
   * pull refusal is not reported (2.9.10 read it as an empty queue); any other pull
   * failure goes to an attached `error` listener (one that throws is logged, never
   * rethrown), or, with none, a permanent one is logged at most once a minute. A failed
   * respawn (already reported as a `crash`) reaches only an attached listener. An
   * unheard `error` is never emitted: EventEmitter would throw it, and the process
   * (2.9.10 kept running) must not end.
   */
  private reportLoopError(error: Error, stage: PullStep['stage']): void {
    if (stage === 'pull') {
      this.pullFailureLog.report(`SandboxedWorker "${this.queueName}"`, this, error);
      return;
    }
    try {
      this.safeEmitError(error);
    } catch (listenerError) {
      log('error', 'An error listener threw', {
        error: listenerError instanceof Error ? listenerError.message : String(listenerError),
      });
    }
  }

  /**
   * Wait `ms` (pollInterval, or a pull-error backoff) before the next pass. A
   * safeTimeout rather than Bun.sleep: it honours a period above the 2^31 - 1 ms
   * native limit in every runtime (bunqueue-client maps Bun.sleep to a native
   * setTimeout), and stop() can end it early through wakePullLoop().
   */
  private waitPull(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const resume = (): void => {
        this.pollWait = null;
        resolve();
      };
      this.pollWait = { timer: safeTimeout(resume, ms), resume };
    });
  }

  protected wakePullLoop(): void {
    const wait = this.pollWait;
    if (!wait) return;
    wait.timer.clear();
    wait.resume();
  }

  protected recycleIdleWorkers(): void {
    if (this.idleRecycleMs <= 0) return;
    const now = Date.now();
    // A thread still loading is neither a spare nor recycled: it is about to be needed.
    let aliveIdleCount = 0;
    for (const worker of this.workers) {
      if (isIdle(worker)) aliveIdleCount++;
    }
    for (const worker of this.workers) {
      if (!isIdle(worker)) continue;
      if (aliveIdleCount <= 1) break;
      if (worker.lastIdleAt > 0 && now - worker.lastIdleAt >= this.idleRecycleMs) {
        worker.worker.terminate();
        worker.terminated = true;
        aliveIdleCount--;
      }
    }
  }

  protected abstract dispatch(worker: WorkerProcess, job: DomainJob, token: string | null): void;
  protected abstract handleMessage(worker: WorkerProcess, message: IPCResponse): void;
  /** A thread died (an error, an exit, a job timeout): fail its job, restart or retire it. */
  protected abstract handleCrash(
    worker: WorkerProcess,
    reason: string,
    reportError?: boolean
  ): void;
  /** Every thread is retired: report it and stop. */
  protected abstract stopExhausted(): void;
}
