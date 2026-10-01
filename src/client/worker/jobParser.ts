/**
 * Job Parser
 * Parses job data from TCP responses
 */

import { parseMaxDelay } from '../../domain/job/create';
import type { BackoffConfig, Job as InternalJob } from '../../domain/types/job';
import { jobId, normalizeLegacyJobPayload } from '../../domain/types/job';

/**
 * Read the object-form backoff (`{ type, delay, maxDelay? }`) the server
 * serializes with every pulled job. Numeric-backoff jobs carry `null`, and a
 * missing field or anything that is not a well-formed config also yields
 * `null`, leaving the numeric `backoff` authoritative. An unusable `maxDelay` is
 * dropped, exactly as job creation does, so the default cap applies instead.
 */
function parseBackoffConfig(value: unknown): BackoffConfig | null {
  if (typeof value !== 'object' || value === null) return null;
  const { type, delay, maxDelay } = value as Record<string, unknown>;
  if (type !== 'fixed' && type !== 'exponential') return null;
  if (typeof delay !== 'number' || !Number.isFinite(delay)) return null;
  const cap = parseMaxDelay(maxDelay);
  return cap === undefined ? { type, delay } : { type, delay, maxDelay: cap };
}

/**
 * Parse job from TCP response data
 */
// eslint-disable-next-line complexity
export function parseJobFromResponse(
  jobData: Record<string, unknown>,
  queueName: string
): InternalJob {
  const payload = normalizeLegacyJobPayload({ name: jobData.name, data: jobData.data });
  return {
    id: jobId(jobData.id as string),
    queue: queueName,
    name: payload.name,
    data: payload.data,
    priority: (jobData.priority as number | undefined) ?? 0,
    createdAt: (jobData.createdAt as number | undefined) ?? Date.now(),
    runAt: (jobData.runAt as number | undefined) ?? Date.now(),
    startedAt: (jobData.startedAt as number | undefined) ?? Date.now(),
    completedAt: null,
    attempts: (jobData.attempts as number | undefined) ?? 0,
    maxAttempts: (jobData.maxAttempts as number | undefined) ?? 3,
    backoff: (jobData.backoff as number | undefined) ?? 1000,
    backoffConfig: parseBackoffConfig(jobData.backoffConfig),
    ttl: (jobData.ttl as number | undefined) ?? null,
    timeout: (jobData.timeout as number | undefined) ?? null,
    uniqueKey: (jobData.uniqueKey as string | undefined) ?? null,
    customId: (jobData.customId as string | undefined) ?? null,
    progress: (jobData.progress as number | undefined) ?? 0,
    progressMessage: (jobData.progressMessage as string | undefined) ?? null,
    dependsOn: Array.isArray(jobData.dependsOn) ? (jobData.dependsOn as string[]) : [],
    parentId: (jobData.parentId as string | undefined) ?? null,
    childrenIds: Array.isArray(jobData.childrenIds) ? (jobData.childrenIds as string[]) : [],
    childrenCompleted: (jobData.childrenCompleted as number | undefined) ?? 0,
    tags: Array.isArray(jobData.tags) ? (jobData.tags as string[]) : [],
    groupId: (jobData.groupId as string | undefined) ?? null,
    lifo: false,
    removeOnComplete: (jobData.removeOnComplete as boolean | undefined) ?? false,
    removeOnFail: false,
    stallCount: 0,
    stallTimeout: null,
    lastHeartbeat: Date.now(),
    repeat: null,
  } as InternalJob;
}
