import { safeTimeout } from '../../../shared/timers';
import { getSharedPool, releaseSharedPool } from '../../tcpPool';
import { WORKER_CONSTANTS } from '../../worker/constants';
import { createTcpOps } from '../queueOps';
import type { WorkerProcess } from '../types';
import { cleanupWrapperScript, createWrapperScript } from '../wrapper';
import { SandboxedState } from './state';

/**
 * Start, stop, idle stop and the `autoStart` idle watch.
 *
 * - The thread teardown is shared: concurrent stops await the same one.
 * - Each stop() supersedes all lifecycle work begun before it. That work captured
 *   `epoch` (an idle stop, a watch check, the restart it began, a start()) and
 *   abandons itself once the epoch moves, so a user stop always wins.
 * - The worker holds at most one shared TCP pool reference. A terminal stop releases
 *   it once; the idle watch keeps it for its Count polls; start() re-acquires it.
 * - A failed start() leaves nothing running and rejects. Begun from the idle watch,
 *   it keeps the pool reference and resumes watching after a backoff; otherwise it
 *   releases the reference, as a stop() would.
 * - `closed` fires once per cycle; a cycle begins at construction and at start().
 */
export abstract class SandboxedLifecycle<T = unknown> extends SandboxedState<T> {
  /** Moved by start() and stop(); lifecycle work from an older epoch abandons. */
  private epoch = 0;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  /** A stop(true) cuts short a graceful drain that is already running. */
  private forceStop = false;
  private closedEmitted = false;
  /**
   * The `autoStart` idle watch is on: a chain of one-shot checks, each armed only after
   * the previous one finished, so at most one Count request is ever in flight.
   */
  private watching = false;
  /** Consecutive failed restarts from the idle watch; a successful start resets it. */
  private restartFailures = 0;

  /**
   * Start the pool. A failure rejects and leaves nothing running: threads, wrapper
   * and heartbeat are torn down. Begun while idle-watching, the worker keeps watching
   * (retrying after a backoff); otherwise it releases its TCP pool reference.
   */
  async start(): Promise<void> {
    // Never start into a teardown: it would terminate the new threads.
    if (this.stopping) await this.stopping;
    if (this.running) return;
    const resumeWatch = this.watching;
    this.cancelWatch();
    const epoch = ++this.epoch;
    this.running = true;
    this.forceStop = false;
    this.closedEmitted = false;
    this.lastActivityTime = Date.now();
    this.acquirePool();
    const starting = this.startPool(epoch);
    this.starting = starting;
    try {
      await starting;
      if (epoch === this.epoch) this.restartFailures = 0;
    } catch (error) {
      if (epoch === this.epoch) await this.abandonStart(epoch, resumeWatch);
      throw error;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  /**
   * Stop the pool: wait for busy threads (or not, with `force`), terminate them, and
   * release the shared TCP pool. Idempotent: later and concurrent calls release
   * nothing again, and only the first emits `closed`. It always wins over an idle
   * stop, an idle-watch check or a restart in progress.
   */
  async stop(force = false): Promise<void> {
    this.epoch++;
    this.cancelWatch();
    await this.teardown(force);
    this.releasePool();
    this.emitClosedOnce();
  }

  isRunning(): boolean {
    return this.running;
  }

  getStats(): { total: number; busy: number; idle: number; recycled: number; restarts: number } {
    const busy = this.workers.filter((worker) => worker.busy && !worker.terminated).length;
    const recycled = this.workers.filter((worker) => worker.terminated).length;
    const alive = this.workers.length - recycled;
    const restarts = this.workers.reduce((sum, worker) => sum + worker.restarts, 0);
    return { total: this.workers.length, busy, idle: alive - busy, recycled, restarts };
  }

  /** Idle stop without `autoStart`: a stop() that a concurrent user stop() or start() supersedes. */
  protected async idleStop(): Promise<void> {
    const epoch = this.epoch;
    await this.teardown(false);
    if (epoch !== this.epoch) return;
    this.releasePool();
    this.emitClosedOnce();
  }

  /** Idle stop with `autoStart`: keep the pool reference and poll the queue for work. */
  protected async stopAndWatch(): Promise<void> {
    const epoch = this.epoch;
    await this.teardown(false);
    if (epoch !== this.epoch) return;
    this.restartFailures = 0;
    this.armWatch(epoch, this.autoStartPollMs);
    this.emitClosedOnce();
  }

  /**
   * One idle-watch check: restart when work is waiting, unless a stop() or start()
   * came first. A failed Count is retried one period later. A failed restart is
   * emitted as `error` (`context: 'restart'`, `consecutiveErrors`); start() has
   * already resumed the watch with a backoff.
   */
  protected async checkAndRestart(epoch: number): Promise<void> {
    let waiting = 0;
    try {
      waiting = await this.ops.countWaiting(this.queueName);
    } catch {
      // Retried after one period, below.
    }
    if (epoch !== this.epoch || !this.watching) return;
    if (waiting <= 0) {
      this.armWatch(epoch, this.autoStartPollMs);
      return;
    }
    try {
      await this.start();
    } catch (errorValue) {
      if (!this.watching) return;
      const error = errorValue instanceof Error ? errorValue : new Error(String(errorValue));
      this.safeEmitError(
        Object.assign(error, {
          queue: this.queueName,
          consecutiveErrors: this.restartFailures,
          context: 'restart' as const,
        })
      );
    }
  }

  protected resetWorkerState(worker: WorkerProcess): void {
    if (worker.timeoutId) {
      worker.timeoutId.clear();
      worker.timeoutId = null;
    }
    worker.busy = false;
    worker.currentJob = null;
    worker.currentToken = null;
    worker.lastIdleAt = Date.now();
  }

  /** Bring the pool up; returns early, leaving cleanup to stop(), once superseded. */
  private async startPool(epoch: number): Promise<void> {
    if (this.tcp) await this.tcp.connect();
    if (epoch !== this.epoch) return;
    this.wrapperPath = await createWrapperScript(this.queueName, this.options.processor);
    if (epoch !== this.epoch) return;
    await this.spawnWorker(0);
    if (this.options.concurrency > 1) {
      const spawnPromises: Promise<void>[] = [];
      for (let index = 1; index < this.options.concurrency; index++) {
        spawnPromises.push(this.spawnWorker(index));
      }
      await Promise.all(spawnPromises);
    }
    if (epoch !== this.epoch) return;
    this.startHeartbeat();
    this.emit('ready');
    this.pullPromise = this.pullLoop();
  }

  /** Stop pulling, drain and terminate the threads; concurrent callers share one run. */
  private teardown(force: boolean): Promise<void> {
    if (force) this.forceStop = true;
    this.running = false;
    // A pull loop waiting out pollInterval (all threads busy) ends at once.
    this.wakePullLoop();
    this.stopping ??= this.terminateThreads().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async terminateThreads(): Promise<void> {
    // A start() in progress returns at its next step; its threads are torn down here.
    await this.starting?.catch(() => undefined);
    await this.pullPromise?.catch(() => undefined);
    // A busy slot is a running job, or a dead thread's FAIL still settling.
    while (!this.forceStop && this.workers.some((worker) => worker.busy)) {
      await Bun.sleep(50);
    }
    if (this.heartbeatTimer) {
      this.heartbeatTimer.clear();
      this.heartbeatTimer = null;
    }
    for (const worker of this.workers) {
      if (worker.timeoutId) {
        worker.timeoutId.clear();
        worker.timeoutId = null;
      }
      if (!worker.terminated) worker.worker.terminate();
    }
    this.workers.length = 0;
    const wrapperPath = this.wrapperPath;
    this.wrapperPath = null;
    await cleanupWrapperScript(wrapperPath);
  }

  /**
   * Undo a start() that failed: tear down what it created, then either resume the
   * idle watch after a backoff (period x 2^failures, at most max(period, 30 s)) or
   * release the TCP pool reference.
   */
  private async abandonStart(epoch: number, resumeWatch: boolean): Promise<void> {
    await this.teardown(true);
    if (epoch !== this.epoch) return;
    if (!resumeWatch) {
      this.releasePool();
      return;
    }
    this.restartFailures++;
    const period = this.autoStartPollMs;
    const cap = Math.max(period, WORKER_CONSTANTS.MAX_BACKOFF_MS);
    this.armWatch(epoch, Math.min(period * 2 ** this.restartFailures, cap));
  }

  /**
   * Arm the next idle-watch check. The delay is autoStartPollMs (a finite period >= 1
   * ms by construction) or a restart backoff; safeTimeout honours one above the
   * 2^31 - 1 ms native limit instead of firing it after ~1 ms.
   */
  private armWatch(epoch: number, delayMs: number): void {
    this.watching = true;
    this.autoStartTimer?.clear();
    this.autoStartTimer = safeTimeout(() => {
      this.autoStartTimer = null;
      void this.checkAndRestart(epoch);
    }, delayMs);
  }

  private cancelWatch(): void {
    this.watching = false;
    this.autoStartTimer?.clear();
    this.autoStartTimer = null;
  }

  /** Take this worker's one shared TCP pool reference back after a terminal stop. */
  private acquirePool(): void {
    if (!this.connection || this.holdsPool) return;
    this.tcp = getSharedPool(this.connection);
    this.ops = createTcpOps(this.tcp);
    this.holdsPool = true;
  }

  /** Release this worker's shared TCP pool reference, at most once per acquisition. */
  private releasePool(): void {
    if (!this.tcp || !this.holdsPool) return;
    this.holdsPool = false;
    releaseSharedPool(this.tcp);
  }

  private emitClosedOnce(): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.emit('closed');
  }

  protected abstract spawnWorker(index: number): Promise<void>;
  protected abstract pullLoop(): Promise<void>;
  /** End a pending pollInterval wait so the pull loop re-checks `running` now. */
  protected abstract wakePullLoop(): void;
  protected abstract startHeartbeat(): void;
  protected abstract safeEmitError(error: Error): void;
}
