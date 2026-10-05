import { EventEmitter } from 'events';
import type { SafeTimer } from '../../../shared/timers';
import type { ConnectionOptions, Job } from '../../types';
import { rejectLegacyConnectionOptions } from '../../legacyConnectionOptions';
import { getSharedManager } from '../../manager';
import { getSharedPool, type TcpConnectionPool } from '../../tcpPool';
import { type QueueOps, createEmbeddedOps, createTcpOps } from '../queueOps';
import type {
  RequiredSandboxedWorkerOptions,
  SandboxedWorkerOptions,
  WorkerProcess,
} from '../types';
import { resolveConcurrency, resolveSandboxedDurations } from './options';

export abstract class SandboxedState<T = unknown> extends EventEmitter {
  on(event: 'ready' | 'closed', listener: () => void): this;
  on(event: 'active', listener: (job: Job<T>) => void): this;
  on(event: 'completed', listener: (job: Job<T>, result: unknown) => void): this;
  on(event: 'failed', listener: (job: Job<T>, error: Error) => void): this;
  on(event: 'progress', listener: (job: Job<T>, progress: number) => void): this;
  on(event: 'log', listener: (job: Job<T>, message: string) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  // oxlint-disable-next-line typescript/no-explicit-any -- EventEmitter's fallback listener is intentionally untyped
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  once(event: 'ready' | 'closed', listener: () => void): this;
  once(event: 'active', listener: (job: Job<T>) => void): this;
  once(event: 'completed', listener: (job: Job<T>, result: unknown) => void): this;
  once(event: 'failed', listener: (job: Job<T>, error: Error) => void): this;
  once(event: 'progress', listener: (job: Job<T>, progress: number) => void): this;
  once(event: 'log', listener: (job: Job<T>, message: string) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  // oxlint-disable-next-line typescript/no-explicit-any -- EventEmitter's fallback listener is intentionally untyped
  once(event: string, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  protected readonly queueName: string;
  protected readonly options: RequiredSandboxedWorkerOptions;
  protected readonly workers: WorkerProcess[] = [];
  protected running = false;
  protected pullPromise: Promise<void> | null = null;
  protected wrapperPath: string | null = null;
  /** Broker operations; rebuilt with `tcp` when start() takes a new pool reference. */
  protected ops: QueueOps;
  /** The shared TCP pool (null embedded). Kept after release, for late event jobs. */
  protected tcp: TcpConnectionPool | null = null;
  /** TCP connection options; start() re-acquires the shared pool with them. */
  protected readonly connection: ConnectionOptions | undefined;
  /** Whether this worker holds its one reference on the shared TCP pool. */
  protected holdsPool = false;
  protected readonly workerId: string;
  protected heartbeatTimer: SafeTimer | null = null;
  /** Heartbeat period in ms; 0 = disabled. */
  protected readonly heartbeatInterval: number;
  /** Idle ms before the pool stops; 0 = disabled. */
  protected readonly idleTimeout: number;
  /** Idle ms before a spare thread is recycled; 0 = disabled. */
  protected readonly idleRecycleMs: number;
  protected readonly autoStart: boolean;
  protected readonly autoStartPollMs: number;
  protected lastActivityTime = 0;
  protected autoStartTimer: SafeTimer | null = null;

  constructor(queueName: string, options: SandboxedWorkerOptions) {
    super();
    // Without `connection` this class runs embedded, so flat keys are rejected
    // unless an embedded manager was injected explicitly.
    rejectLegacyConnectionOptions('SandboxedWorker', options, options.manager !== undefined);
    // Validate every numeric option before a shared pool or manager is acquired, so
    // an invalid option leaks nothing.
    const durations = resolveSandboxedDurations(options, Boolean(options.connection));
    const concurrency = resolveConcurrency(options.concurrency);
    this.queueName = queueName;
    this.workerId = `sandboxed-worker-${queueName}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.connection = options.connection;

    if (options.connection) {
      this.tcp = getSharedPool(options.connection);
      this.holdsPool = true;
      this.ops = createTcpOps(this.tcp);
    } else {
      this.ops = createEmbeddedOps(options.manager ?? getSharedManager());
    }

    this.heartbeatInterval = durations.heartbeatInterval;
    this.idleTimeout = durations.idleTimeout;
    this.idleRecycleMs = durations.idleRecycleMs;
    this.autoStart = options.autoStart ?? false;
    this.autoStartPollMs = durations.autoStartPollMs;
    this.options = {
      processor: options.processor,
      concurrency,
      maxMemory: options.maxMemory ?? 256,
      timeout: durations.timeout,
      autoRestart: options.autoRestart ?? true,
      maxRestarts: options.maxRestarts ?? 10,
      pollInterval: durations.pollInterval,
    };
  }
}
