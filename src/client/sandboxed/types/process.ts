import type { Job as DomainJob } from '../../../domain/types/job';

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
  timeoutId: ReturnType<typeof setTimeout> | null;
  lastIdleAt: number;
  terminated: boolean;
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
  progress?: number;
  message?: string;
}
