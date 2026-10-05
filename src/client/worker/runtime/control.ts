import { hostname } from 'os';
import { jobId } from '../../../domain/types/job';
import { EventType } from '../../../domain/types/queue';
import { assertDuration } from '../../../shared/durations';
import { safeInterval, safeTimeout, type SafeTimer } from '../../../shared/timers';
import { getSharedManager } from '../../manager';
import { coerceNumericString } from '../../tcp/numeric';
import { TcpEventSubscription } from '../../queue-events/tcpSubscription';
import type { Job } from '../../types';
import { startHeartbeat } from '../workerHeartbeat';
import { resolveWorkerConcurrency } from './options';
import { WorkerState } from './state';

export abstract class WorkerControl<T = unknown, R = unknown> extends WorkerState<T, R> {
  run(): void {
    if (this.running || this.closed || this._closing || this._closingPromise !== null) return;
    this.running = true;
    this.paused = false;
    queueMicrotask(() => {
      if (!this.closed) this.emit('ready');
    });

    if (!this.stalledUnsubscribe && !this.opts.skipStalledCheck) {
      this.subscribeToStalledEvents();
    }

    if (this.embedded && !this.registered) {
      getSharedManager().registerWorker(this.queueKey, [this.queueKey], this.opts.concurrency, {
        workerId: this.workerId,
        hostname: hostname(),
        pid: process.pid,
        startedAt: this.startedAt,
      });
      this.registered = true;
    } else if (this.tcp && !this.registered) {
      this.registerWithServer();
    }

    // heartbeatInterval is validated (finite, >= 0; 0 disables) and armed with
    // safeInterval, so an interval above the native timer limit cannot spin.
    if (this.opts.heartbeatInterval > 0 && !this.opts.skipLockRenewal && !this.heartbeatTimer) {
      if (this.embedded) {
        this.heartbeatTimer = safeInterval(() => {
          const manager = getSharedManager();
          for (const id of this.pulledJobIds) {
            const token = this.opts.useLocks ? this.jobTokens.get(id) : undefined;
            manager.jobHeartbeat(jobId(id), token);
          }
        }, this.opts.heartbeatInterval);
      } else {
        this.heartbeatTimer = startHeartbeat(this.getHeartbeatDeps(), this.opts.heartbeatInterval);
      }
    }
    if (this.opts.heartbeatInterval > 0) this.startWorkerHeartbeat();
    if (this.stalledSubscription) {
      void this.stalledSubscription.waitUntilReady().then(
        () => this.poll(),
        () => this.poll()
      );
    } else {
      this.poll();
    }
  }

  protected subscribeToStalledEvents(): void {
    const handleEvent = (event: { queue: string; eventType: EventType; jobId: string }) => {
      if (event.queue !== this.queueKey) return;
      if (event.eventType === EventType.Stalled) {
        this.emit('stalled', event.jobId, 'active');
      }
    };
    if (this.embedded) {
      this.stalledUnsubscribe = getSharedManager().subscribe(handleEvent);
      return;
    }

    const subscription = new TcpEventSubscription({
      connection: this.opts.connection,
      queue: this.queueKey,
      onEvent: handleEvent,
      onError: (error) => {
        if (this.listenerCount('error') > 0) this.emit('error', error);
      },
    });
    this.stalledSubscription = subscription;
    this.stalledUnsubscribe = () => {
      subscription.close();
      if (this.stalledSubscription === subscription) this.stalledSubscription = null;
    };
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.paused = true;
    this.clearPollTimer();
    this.ackBatcher.notifyCapacityChanged();
  }

  resume(): void {
    if (this.closed) return;
    this.paused = false;
    this.run();
  }

  isRunning(): boolean {
    return this.running;
  }

  isPaused(): boolean {
    return this.paused && !this.closed;
  }

  isClosed(): boolean {
    return this.closed;
  }

  get concurrency(): number {
    return this.opts.concurrency;
  }

  /**
   * As on 2.9.10 (`Math.max(1, value)`): values below 1 and `null` are clamped to 1
   * (documented), a fraction rounds up (the gate is `active >= concurrency`), Infinity
   * removes the limit and a numeric string is that number. NaN (the gate would never
   * close) or another non-number throws.
   */
  set concurrency(value: number) {
    const coerced = coerceNumericString(value);
    const clamped =
      coerced === null || (typeof coerced === 'number' && coerced < 1)
        ? 1
        : resolveWorkerConcurrency(coerced, 'Worker.concurrency');
    const previous = this.opts.concurrency;
    (this.opts as { concurrency: number }).concurrency = clamped;
    this.ackBatcher.notifyCapacityChanged();
    if (clamped > previous && this.running && !this._closing) this.poll();
  }

  get closing(): Promise<void> | null {
    return this._closingPromise;
  }

  async waitUntilReady(): Promise<void> {
    if (this.embedded) return;
    if (this.tcpPool) await this.tcpPool.send({ cmd: 'Ping' });
    if (this.stalledSubscription) await this.stalledSubscription.waitUntilReady();
  }

  cancelJob(jobId: string, reason?: string): boolean {
    if (this.hasActiveDelivery(jobId)) {
      this.cancelledJobs.add(jobId);
      const message = reason ?? 'Job cancelled by worker';
      this.abortJob(jobId, message);
      this.emit('cancelled', { jobId, reason: message });
      return true;
    }
    return false;
  }

  cancelAllJobs(reason?: string): void {
    for (const jobId of this.activeDeliveryIds()) {
      this.cancelledJobs.add(jobId);
      const message = reason ?? 'All jobs cancelled';
      this.abortJob(jobId, message);
      this.emit('cancelled', { jobId, reason: message });
    }
  }

  isJobCancelled(jobId: string): boolean {
    return this.cancelledJobs.has(jobId);
  }

  getRateLimiterInfo() {
    return this.rateLimiter.getRateLimiterInfo();
  }

  /**
   * Block new starts for `expireTimeMs`. As on 2.9.10 (BullMQ v5), a value that is not
   * a positive finite number (0, negative, NaN, Infinity, `null`) does nothing, and a
   * numeric string is that number; any other non-number throws a TypeError. A wait
   * above the native timer limit parks the pull loop on a `safeTimeout` instead of
   * spinning.
   */
  rateLimit(expireTimeMs: number): void {
    const ms = coerceNumericString(expireTimeMs ?? 0);
    if (typeof ms !== 'number') assertDuration(ms, 'Worker.rateLimit: expireTimeMs');
    this.rateLimiter.rateLimit(ms as number);
    this.ackBatcher.notifyCapacityChanged();
  }

  isRateLimited(): boolean {
    return this.rateLimiter.isRateLimited();
  }

  async rateLimitGroup(job: Job<T>, duration: number): Promise<void> {
    const groupId = job.opts.group?.id;
    if (groupId === undefined) throw new Error('Cannot rate limit a job without a group');
    if (!Number.isSafeInteger(duration) || duration <= 0) {
      throw new Error('duration must be a positive safe integer');
    }
    if (this.embedded) {
      await getSharedManager().rateLimitGroup(this.queueKey, String(groupId), duration);
    } else {
      if (!this.tcp) throw new Error('TCP connection is unavailable for group rate limiting');
      const response = await this.tcp.send({
        cmd: 'RateLimitGroup',
        queue: this.queueKey,
        groupId: String(groupId),
        duration,
      });
      if (!response.ok) throw new Error(String(response.error ?? 'Group rate limiting failed'));
    }
    await job.moveToWait(job.token);
  }

  async startStalledCheckTimer(): Promise<void> {
    // No-op for API compatibility; stall detection is automatic.
  }

  /**
   * BullMQ-compatible `delay(milliseconds?, abortController?)`. Omitted, `null`, 0 or a
   * negative value resolves at once (as on 2.9.10 and in BullMQ), and a numeric string
   * is that number; NaN, Infinity and another non-number reject. Any longer delay is honoured exactly. Aborting, or passing a
   * controller that is already aborted, rejects with `Delay aborted`.
   */
  async delay(milliseconds?: number, abortController?: AbortController): Promise<void> {
    const requested = coerceNumericString(milliseconds ?? 0);
    if (typeof requested === 'number' && requested <= 0) return;
    const ms = assertDuration(requested, 'Worker.delay: milliseconds');
    if (ms === 0) return;
    const signal = abortController?.signal;
    if (signal?.aborted) throw new Error('Delay aborted');
    return new Promise<void>((resolve, reject) => {
      let timer: SafeTimer | null = null;
      const onAbort = (): void => {
        timer?.clear();
        reject(new Error('Delay aborted'));
      };
      timer = safeTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
