/**
 * Job-option and lock-token types of the MCP backend contract. Every field is honored
 * end to end by both backends (embedded QueueManager and the TCP broker).
 */

/** Retry backoff: a base delay in ms (exponential growth) or an explicit strategy. */
export type McpBackoff =
  | number
  | { type: 'fixed' | 'exponential'; delay: number; maxDelay?: number };

/** Unique-key deduplication within a queue. */
export interface McpDeduplication {
  id: string;
  ttl?: number;
  extend?: boolean;
  replace?: boolean;
}

/** Options accepted when adding a job through MCP. */
export interface McpJobOptions {
  priority?: number;
  delay?: number;
  attempts?: number;
  backoff?: McpBackoff;
  timeout?: number;
  /** Custom id: becomes the job id; idempotent while that job is unfinished. */
  jobId?: string;
  deduplication?: McpDeduplication;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  /** Bypass the write buffer. */
  durable?: boolean;
  lifo?: boolean;
  tags?: string[];
  stallTimeout?: number;
}

/**
 * Options of a flow job. Atomic flows reject deduplication, do not store tags and are
 * always written durably, so those fields are not accepted; a flow `jobId` must be new.
 */
export type McpFlowJobOptions = Omit<McpJobOptions, 'deduplication' | 'tags' | 'durable'>;

/** One job of a bulk add. */
export interface McpBulkJob extends McpJobOptions {
  name: string;
  data: unknown;
}

/** Add options as stored on a job; defaults are omitted (backoff is always present). */
export interface SerializedJobOptions {
  backoff?: McpBackoff;
  timeout?: number;
  stallTimeout?: number;
  lifo?: boolean;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  tags?: string[];
  /** The deduplication key the job was added with. */
  deduplicationId?: string;
}

/** Lock requested by a manual pull: the broker issues a token only when `owner` is set. */
export interface PullLockOptions {
  owner: string;
  lockTtl?: number;
}

/** Options of a manual failure. */
export interface FailJobOptions {
  /** Lock token of a job pulled with an owner. */
  token?: string;
  /** Skip the remaining attempts: the job goes straight to the DLQ (or is removed). */
  unrecoverable?: boolean;
}
