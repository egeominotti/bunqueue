import type { CronJobInput } from '../../domain/types/cron';
import type { JobLogEntry } from '../../domain/types/worker';
import type { DlqQuery, QueueLimits, SerializedDlqEntry, SerializedDlqStats } from './inspection';
import type {
  FailJobOptions,
  McpBulkJob,
  McpFlowJobOptions,
  McpJobOptions,
  PullLockOptions,
  SerializedJobOptions,
} from './jobOptions';

export type {
  FailJobOptions,
  McpBackoff,
  McpBulkJob,
  McpDeduplication,
  McpFlowJobOptions,
  McpJobOptions,
  PullLockOptions,
  SerializedJobOptions,
} from './jobOptions';
export type {
  DlqQuery,
  QueueLimits,
  SerializedDlqAttempt,
  SerializedDlqEntry,
  SerializedDlqStats,
} from './inspection';

export interface JobCounts {
  waiting: number;
  prioritized: number;
  delayed: number;
  active: number;
  completed: number;
  failed: number;
  /** Ready jobs (waiting + prioritized) of a paused queue; they are then 0 in their own buckets. */
  paused: number;
  /** Flow parents waiting for their children (optional: older backends omit it). */
  'waiting-children'?: number;
}

export interface SerializedJob extends SerializedJobOptions {
  id: string;
  name: string;
  queue: string;
  data: unknown;
  priority: number;
  state?: string;
  progress: number;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string;
}

/** A pulled job; `token` is present only when the pull set an owner and a lock was issued. */
export interface PulledJob extends SerializedJob {
  token?: string;
}

export interface SerializedCron {
  name: string;
  queue: string;
  schedule?: string;
  repeatEvery?: number;
  nextRun: string | null;
  executions: number;
  /** Name given to every job the cron produces ("default" when not set). */
  jobName: string;
  /** Priority of every produced job. */
  priority: number;
  /** IANA time zone the schedule is evaluated in (null = UTC). */
  timezone: string | null;
  /** Total number of runs before the cron stops (null = unlimited). */
  maxLimit: number | null;
}

export interface WebhookInfo {
  id: string;
  url: string;
  events: string[];
  queue?: string;
  enabled: boolean;
}

export interface WorkerInfo {
  id: string;
  name: string;
  queues: string[];
  active: number;
  processed: number;
  failed: number;
  lastHeartbeat: number;
}

export interface FlowJobInput {
  name: string;
  queueName: string;
  data?: Record<string, unknown>;
  opts?: McpFlowJobOptions;
  children?: FlowJobInput[];
}

export interface FlowStepInput {
  name: string;
  queueName: string;
  data: Record<string, unknown>;
  opts?: McpFlowJobOptions;
}

export interface FlowNodeResult {
  jobId: string;
  name: string;
  queueName: string;
  children?: FlowNodeResult[];
}

/** Common backend contract; all methods are async for TCP compatibility. */
export interface McpBackend {
  addJob(
    queue: string,
    name: string,
    data: unknown,
    opts?: McpJobOptions
  ): Promise<{ jobId: string }>;
  addJobsBulk(queue: string, jobs: McpBulkJob[]): Promise<{ jobIds: string[] }>;
  getJob(jobId: string): Promise<SerializedJob | null>;
  getJobState(jobId: string): Promise<string>;
  getJobResult(jobId: string): Promise<unknown>;
  getProgress(jobId: string): Promise<{ progress: number; message: string | null } | null>;
  cancelJob(jobId: string): Promise<boolean>;
  promoteJob(jobId: string): Promise<boolean>;
  updateProgress(jobId: string, progress: number, message?: string): Promise<boolean>;
  updateJobData(jobId: string, data: unknown): Promise<boolean>;
  changeJobPriority(jobId: string, priority: number): Promise<boolean>;
  moveToDelayed(jobId: string, delay: number): Promise<boolean>;
  changeDelay(jobId: string, delay: number): Promise<boolean>;
  discardJob(jobId: string): Promise<boolean>;
  getChildrenValues(parentJobId: string): Promise<Record<string, unknown>>;
  getJobByCustomId(customId: string): Promise<SerializedJob | null>;
  waitForJobCompletion(jobId: string, timeoutMs: number): Promise<boolean>;

  pullJob(queue: string, timeoutMs?: number, lock?: PullLockOptions): Promise<PulledJob | null>;
  pullJobBatch(
    queue: string,
    count: number,
    timeoutMs?: number,
    lock?: PullLockOptions
  ): Promise<PulledJob[]>;
  ackJob(jobId: string, result?: unknown, token?: string): Promise<void>;
  /** `tokens` is aligned with `jobIds`; an empty entry means "no token". */
  ackJobBatch(jobIds: string[], tokens?: string[]): Promise<void>;
  failJob(jobId: string, error?: string, opts?: FailJobOptions): Promise<void>;
  jobHeartbeat(jobId: string, token?: string): Promise<boolean>;
  jobHeartbeatBatch(jobIds: string[], tokens?: string[]): Promise<number>;
  extendLock(jobId: string, token: string, duration: number): Promise<boolean>;

  getJobs(
    queue: string,
    opts?: { state?: string; start?: number; end?: number }
  ): Promise<SerializedJob[]>;
  getJobCounts(queue: string): Promise<JobCounts>;
  pauseQueue(queue: string): Promise<void>;
  resumeQueue(queue: string): Promise<void>;
  drainQueue(queue: string): Promise<number>;
  obliterateQueue(queue: string): Promise<void>;
  listQueues(): Promise<string[]>;
  countJobs(queue: string): Promise<number>;
  cleanQueue(queue: string, graceMs: number, state?: string, limit?: number): Promise<string[]>;
  isPaused(queue: string): Promise<boolean>;
  getCountsPerPriority(queue: string): Promise<Record<number, number>>;

  getDlq(queue: string, limit?: number): Promise<SerializedJob[]>;
  /** DLQ entries oldest first; `hasMore` when entries beyond `offset + limit` match. */
  getDlqEntries(
    queue: string,
    query: DlqQuery
  ): Promise<{ entries: SerializedDlqEntry[]; hasMore: boolean }>;
  getDlqStats(queue: string): Promise<SerializedDlqStats>;
  retryDlq(queue: string, jobId?: string): Promise<number>;
  purgeDlq(queue: string): Promise<number>;
  retryCompleted(queue: string, jobId?: string): Promise<number>;
  /** `durationMs` is the window `limit` applies to (broker default 1000). */
  setRateLimit(queue: string, limit: number, durationMs?: number): Promise<void>;
  clearRateLimit(queue: string): Promise<void>;
  setConcurrency(queue: string, limit: number): Promise<void>;
  clearConcurrency(queue: string): Promise<void>;
  getQueueLimits(queue: string): Promise<QueueLimits>;

  addCron(input: CronJobInput): Promise<SerializedCron>;
  getCron(name: string): Promise<SerializedCron | null>;
  listCrons(): Promise<SerializedCron[]>;
  deleteCron(name: string): Promise<boolean>;
  addWebhook(url: string, events: string[], queue?: string): Promise<WebhookInfo>;
  removeWebhook(id: string): Promise<boolean>;
  listWebhooks(): Promise<WebhookInfo[]>;
  setWebhookEnabled(id: string, enabled: boolean): Promise<boolean>;
  registerWorker(name: string, queues: string[]): Promise<WorkerInfo>;
  unregisterWorker(id: string): Promise<boolean>;
  workerHeartbeat(id: string): Promise<boolean>;
  listWorkers(): Promise<WorkerInfo[]>;

  getStats(): Promise<Record<string, unknown>>;
  getPerQueueStats(): Promise<Record<string, unknown>>;
  getMemoryStats(): Promise<Record<string, unknown>>;
  getPrometheusMetrics(): Promise<string>;
  getStorageStatus(): Promise<{ diskFull: boolean; error: string | null }>;
  getJobLogs(jobId: string): Promise<JobLogEntry[]>;
  addJobLog(jobId: string, message: string, level?: 'info' | 'warn' | 'error'): Promise<boolean>;
  clearJobLogs(jobId: string, keepLogs?: number): Promise<void>;
  compactMemory(): Promise<void>;

  addFlow(flow: FlowJobInput): Promise<FlowNodeResult>;
  addFlowChain(steps: FlowStepInput[]): Promise<{ jobIds: string[] }>;
  addFlowBulkThen(
    parallel: FlowStepInput[],
    final: FlowStepInput
  ): Promise<{ parallelIds: string[]; finalId: string }>;
  getFlow(
    jobId: string,
    queueName: string,
    depth?: number,
    maxChildren?: number
  ): Promise<FlowNodeResult | null>;
  shutdown(): void;
}
