import type { Job as DomainJob } from '../../../domain/types/job';
import type { SafeTimer } from '../../../shared/timers';

/**
 * The pool only posts jobs to and terminates a sandbox thread: Bun's Web Worker
 * here, a worker_threads adapter in bunqueue-client. Portable types keep the
 * published declarations free of Bun and DOM globals.
 */
export interface SandboxThread {
  postMessage(message: unknown): void;
  terminate(): unknown;
}

export interface WorkerProcess {
  worker: SandboxThread;
  busy: boolean;
  currentJob: DomainJob | null;
  currentToken: string | null;
  restarts: number;
  /** The per-job timeout armed for `currentJob`; cancel it with `clear()`. */
  timeoutId: SafeTimer | null;
  lastIdleAt: number;
  /** Not running: recycled while idle, terminated by its job timeout, or crashed. */
  terminated: boolean;
  /** The thread's death was handled (its job failed, a restart decided); once only. */
  crashed: boolean;
  /** Crashed beyond the restart budget: never respawned and never given a job. */
  retired: boolean;
  /**
   * Spawned, its processor module still loading: given no job until the thread posts
   * `ready`. A message reaching a thread before then could be lost. Unset = loaded.
   */
  loading?: boolean;
}

export interface IPCRequest {
  type: 'job';
  job: {
    id: string;
    name: string;
    data: unknown;
    queue: string;
    attempts: number;
    parentId?: string;
  };
}

export interface IPCResponse {
  type: 'result' | 'error' | 'progress' | 'log' | 'fail' | 'ready';
  jobId?: string;
  result?: unknown;
  error?: string;
  /** What the processor passed to `job.progress()`: a number, or a BullMQ-style object. */
  progress?: unknown;
  message?: string;
}
