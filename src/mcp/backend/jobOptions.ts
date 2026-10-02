/**
 * Maps MCP job options to the engine's job input. Both backends use these functions,
 * so an option means the same thing in embedded and TCP mode:
 * - embedded: `toJobInput` feeds QueueManager.push / pushBatch directly;
 * - TCP PUSH: `toPushFields` (the custom id travels as `jobId`, as the PUSH handler expects);
 * - TCP PUSHB: `toJobInput` per job (PUSHB jobs are engine inputs, so it travels as `customId`).
 * Fields left undefined are omitted, never sent as null.
 */

import type { JobInput } from '../../domain/types/job';
import type { McpBulkJob, McpJobOptions } from '../types/adapter';

/** Copy of `fields` without its undefined entries. */
function defined<T extends Record<string, unknown>>(fields: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(fields) as Array<keyof T>) {
    if (fields[key] !== undefined) out[key] = fields[key];
  }
  return out;
}

/** Every option except the custom id, in engine field names. */
function engineFields(opts: McpJobOptions): Omit<JobInput, 'name' | 'data' | 'customId'> {
  const dedup = opts.deduplication;
  return defined({
    priority: opts.priority,
    delay: opts.delay,
    maxAttempts: opts.attempts,
    backoff: opts.backoff,
    timeout: opts.timeout,
    // The deduplication key rides on uniqueKey; the strategy on dedup (as the client SDK does).
    uniqueKey: dedup?.id,
    dedup: dedup
      ? defined({ ttl: dedup.ttl, extend: dedup.extend, replace: dedup.replace })
      : undefined,
    removeOnComplete: opts.removeOnComplete,
    removeOnFail: opts.removeOnFail,
    durable: opts.durable,
    lifo: opts.lifo,
    tags: opts.tags,
    stallTimeout: opts.stallTimeout,
  });
}

/** Engine input for one job (embedded push and each TCP PUSHB job). */
export function toJobInput(name: string, data: unknown, opts: McpJobOptions = {}): JobInput {
  return {
    name,
    data,
    ...engineFields(opts),
    ...(opts.jobId === undefined ? {} : { customId: opts.jobId }),
  };
}

/** Engine input for one bulk item. */
export function toBulkJobInput(job: McpBulkJob): JobInput {
  return toJobInput(job.name, job.data, job);
}

/** Option fields of a TCP PUSH command. */
export function toPushFields(opts: McpJobOptions = {}): Record<string, unknown> {
  return {
    ...engineFields(opts),
    ...(opts.jobId === undefined ? {} : { jobId: opts.jobId }),
  };
}
