/**
 * The add options a job carries, in MCP output form. Shared by the embedded serializer
 * (a domain Job) and the TCP parser (the broker's job reply), so both modes report the
 * same fields: defaults are omitted, except `backoff`, which every job has.
 */

import type { McpBackoff, SerializedJobOptions } from '../types/adapter';

type OptionKey =
  | 'backoff'
  | 'backoffConfig'
  | 'timeout'
  | 'stallTimeout'
  | 'lifo'
  | 'removeOnComplete'
  | 'removeOnFail'
  | 'tags'
  | 'uniqueKey';

/** A domain Job or a broker job reply: only the option fields are read. */
export type JobOptionSource = { readonly [K in OptionKey]?: unknown };

function backoffOf(job: JobOptionSource): McpBackoff | undefined {
  const config = job.backoffConfig;
  if (config !== null && typeof config === 'object') {
    const { type, delay, maxDelay } = config as Record<string, unknown>;
    if ((type === 'fixed' || type === 'exponential') && typeof delay === 'number') {
      return typeof maxDelay === 'number' ? { type, delay, maxDelay } : { type, delay };
    }
  }
  return typeof job.backoff === 'number' ? job.backoff : undefined;
}

export function serializeJobOptions(job: JobOptionSource): SerializedJobOptions {
  const view: SerializedJobOptions = {};
  const backoff = backoffOf(job);
  if (backoff !== undefined) view.backoff = backoff;
  if (typeof job.timeout === 'number') view.timeout = job.timeout;
  if (typeof job.stallTimeout === 'number') view.stallTimeout = job.stallTimeout;
  if (job.lifo === true) view.lifo = true;
  if (job.removeOnComplete === true) view.removeOnComplete = true;
  if (job.removeOnFail === true) view.removeOnFail = true;
  if (Array.isArray(job.tags) && job.tags.length > 0) {
    view.tags = job.tags.filter((tag): tag is string => typeof tag === 'string');
  }
  if (typeof job.uniqueKey === 'string') view.deduplicationId = job.uniqueKey;
  return view;
}
