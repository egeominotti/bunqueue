import type { FlowJobData, Job, Processor, QueueOptions, WorkerOptions } from '../types';
import { rejectLegacyConnectionOptions } from '../legacyConnectionOptions';
import { errorEventListener, setBackgroundErrorListener } from '../queue/backgroundCommand';
import { FORCE_EMBEDDED } from '../queue/helpers';
import { Queue } from '../queue/queue';
import { Worker } from '../worker/worker';
import { PriorityAger } from './aging';
import { BatchAccumulator } from './batch';
import { CancellationManager } from './cancellation';
import { WorkerCircuitBreaker } from './circuitBreaker';
import { DedupDebounceMerger } from './dedupDebounce';
import { DlqRateLimitManager } from './dlqRateLimit';
import { executeWithRetry } from './retry';
import { TriggerManager } from './triggers';
import { TtlChecker } from './ttl';
import type { BunqueueMiddleware, BunqueueOptions } from './types';
import { resolveBunqueueFeatures } from './validation';
import { resolveProcessorResult } from '../worker/processorResult';

/** Closing a Worker whose construction is being rolled back is best-effort. */
const ignoreCloseFailure = (): void => undefined;

/** Construction and processing pipeline shared by the compact Bunqueue façade. */
export abstract class BunqueueRuntime<T, R> {
  readonly name: string;
  readonly queue: Queue<T>;
  readonly worker: Worker<T, R>;
  private readonly middlewares: BunqueueMiddleware<T, R>[] = [];
  private readonly baseProcessor: Processor<T, R>;
  protected readonly cb: WorkerCircuitBreaker | null;
  private readonly retryConfig: BunqueueOptions<T, R>['retry'] | null;
  protected readonly triggerMgr: TriggerManager<T, R>;
  protected readonly ager: PriorityAger<T> | null;
  protected readonly cancellation = new CancellationManager();
  protected readonly ttlChecker: TtlChecker | null;
  protected readonly batchAcc: BatchAccumulator<T, R> | null;
  protected readonly merger: DedupDebounceMerger;
  protected readonly dlqrl: DlqRateLimitManager<T>;

  constructor(name: string, options: BunqueueOptions<T, R>) {
    rejectLegacyConnectionOptions('Bunqueue', options, options.embedded ?? FORCE_EMBEDDED);
    const modes = [options.processor, options.routes, options.batch].filter(Boolean).length;
    if (modes === 0) throw new Error('Bunqueue requires "processor", "routes", or "batch"');
    if (modes > 1) throw new Error('Bunqueue: use only one of "processor", "routes", or "batch"');
    // Before the Queue and Worker exist: a rejected option must leave nothing running.
    // Normalized copies, so the settings cannot be changed through the caller's objects.
    const features = resolveBunqueueFeatures(options);

    this.name = name;
    this.retryConfig = features.retry;
    this.ttlChecker = options.ttl ? new TtlChecker(options.ttl) : null;
    this.merger = new DedupDebounceMerger(options.deduplication ?? null, options.debounce ?? null);

    if (features.batch) {
      this.batchAcc = new BatchAccumulator<T, R>(features.batch);
      this.baseProcessor = this.batchAcc.buildProcessor();
    } else {
      this.batchAcc = null;
      this.baseProcessor = options.routes
        ? this.buildRouteProcessor(options.routes)
        : (options.processor as Processor<T, R>);
    }

    const wrappedProcessor: Processor<T, R> = (job: Job<T & FlowJobData>) => this.processJob(job);
    this.queue = new Queue<T>(name, this.buildQueueOptions(options));
    let worker: Worker<T, R> | null = null;
    try {
      // The Worker validates the options forwarded to it and may throw here.
      worker = new Worker<T, R>(name, wrappedProcessor, this.buildWorkerOptions(options));
      // Fire-and-forget failures (the `dlq` option's SetDlqConfig below, pause(),
      // setGlobalRateLimit()...) go to the `error` event while it has a listener.
      const onBackgroundError = errorEventListener(worker);
      setBackgroundErrorListener(this.queue, onBackgroundError);
      this.dlqrl = new DlqRateLimitManager<T>(this.queue);
      if (options.dlq) this.dlqrl.setDlqConfig(options.dlq);

      this.cb = features.circuitBreaker
        ? new WorkerCircuitBreaker(features.circuitBreaker, worker as unknown as Worker)
        : null;
      this.triggerMgr = new TriggerManager<T, R>(this.queue, worker, {
        name: (options.prefixKey ?? '') + name,
        onBackgroundError,
      });
      this.ager = features.priorityAging
        ? new PriorityAger<T>(features.priorityAging, this.queue)
        : null;
      this.ager?.start();
    } catch (error) {
      // A failed construction leaves nothing running: no polling Worker, no Queue
      // holding a reference on a shared TCP pool.
      if (worker) worker.close(true).catch(ignoreCloseFailure);
      this.queue.close();
      throw error;
    }
    this.worker = worker;
  }

  private buildRouteProcessor(routes: Record<string, Processor<T, R>>): Processor<T, R> {
    const routeMap: Partial<Record<string, Processor<T, R>>> = routes;
    return (job: Job<T & FlowJobData>, context) => {
      const handler = routeMap[job.name];
      if (!handler) throw new Error(`No route for job "${job.name}" in queue "${this.name}"`);
      return handler(job, context);
    };
  }

  private buildQueueOptions(options: BunqueueOptions<T, R>): QueueOptions {
    return {
      connection: options.connection,
      embedded: options.embedded,
      dataPath: options.dataPath,
      defaultJobOptions: options.defaultJobOptions,
      autoBatch: options.autoBatch,
      prefixKey: options.prefixKey,
    };
  }

  private buildWorkerOptions(options: BunqueueOptions<T, R>): WorkerOptions {
    return {
      connection: options.connection,
      embedded: options.embedded,
      dataPath: options.dataPath,
      concurrency: options.concurrency,
      autorun: options.autorun,
      heartbeatInterval: options.heartbeatInterval,
      batchSize: options.batchSize,
      pollTimeout: options.pollTimeout,
      limiter: options.rateLimit ?? options.limiter,
      removeOnComplete: options.removeOnComplete,
      removeOnFail: options.removeOnFail,
      prefixKey: options.prefixKey,
    };
  }

  private processJob(job: Job<T & FlowJobData>): Promise<R> {
    if (this.cb?.isOpen()) return Promise.reject(new Error('Circuit breaker is open'));
    if (this.ttlChecker?.isExpired(job.name, job.timestamp)) {
      return Promise.reject(new Error(`Job expired (age: ${Date.now() - job.timestamp}ms)`));
    }

    const abortController = this.cancellation.register(job.id);
    const runChain = () => this.runMiddlewareChain(job, abortController);
    let execution: Promise<R>;
    try {
      execution = this.retryConfig
        ? executeWithRetry(runChain, this.retryConfig, abortController.signal)
        : runChain();
    } catch (error) {
      execution = Promise.reject(error);
    }
    return execution.then(
      (result) => {
        try {
          this.cb?.onSuccess();
          return result;
        } finally {
          this.cancellation.unregister(job.id, abortController);
        }
      },
      (error: unknown) => {
        try {
          this.cb?.onFailure();
          throw error;
        } finally {
          this.cancellation.unregister(job.id, abortController);
        }
      }
    );
  }

  private runMiddlewareChain(
    job: Job<T & FlowJobData>,
    abortController: AbortController
  ): Promise<R> {
    if (abortController.signal.aborted) return Promise.reject(new Error('Job cancelled'));
    const publicJob = job as unknown as Job<T>;
    if (this.middlewares.length === 0) {
      return resolveProcessorResult(
        this.baseProcessor(job, { signal: abortController.signal }),
        abortController.signal
      );
    }
    let index = 0;
    const next = (): Promise<R> => {
      if (abortController.signal.aborted) return Promise.reject(new Error('Job cancelled'));
      if (index < this.middlewares.length) return this.middlewares[index++](publicJob, next);
      return resolveProcessorResult(
        this.baseProcessor(job, { signal: abortController.signal }),
        abortController.signal
      );
    };
    return next();
  }

  use(middleware: BunqueueMiddleware<T, R>): this {
    this.middlewares.push(middleware);
    return this;
  }
}
