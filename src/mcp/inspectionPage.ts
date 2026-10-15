import type { McpBackend, SerializedJob } from './types/adapter';
import { boundedValue, MAX_INSPECTION_BYTES, MAX_VALUE_BYTES } from './inspectionBounds';

export const INSPECTION_STATES = [
  'waiting',
  'prioritized',
  'delayed',
  'active',
  'completed',
  'failed',
  'paused',
  'waiting-children',
] as const;

/** Explicit allowlist: payload, tags, deduplication keys and progress messages are private. */
export function jobSummary(job: SerializedJob) {
  const name = boundedValue(job.name);
  const value: Record<string, unknown> = {
    id: job.id,
    name: name.value,
    queue: job.queue,
    state: job.state,
    priority: job.priority,
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
  };
  let truncated = name.truncated;
  const omittedFields: string[] = [];
  // Prefer the usable job ID over optional labels or the queue identifier.
  for (const field of ['name', 'queue', 'id']) {
    if (Buffer.byteLength(JSON.stringify(value)) <= MAX_VALUE_BYTES - 128) break;
    delete value[field];
    omittedFields.push(field);
    truncated = true;
  }
  if (omittedFields.length) {
    value.omittedFields = omittedFields;
    value.omittedIdentifiers = omittedFields.filter((field) => field !== 'name');
  }
  return { value, truncated };
}

export async function listJobsPage(
  backend: McpBackend,
  args: { queue: string; state?: string; offset?: number; limit?: number; includeData?: boolean }
) {
  const { queue, state, includeData = false, offset = 0, limit = 20 } = args;
  const raw = await backend.getJobs(queue, { state, start: offset, end: offset + limit + 1 });
  const jobs: Record<string, unknown>[] = [];
  let truncated = false;
  for (const job of raw.slice(0, limit)) {
    const summary = jobSummary(job);
    const item = summary.value;
    item.summaryTruncated = summary.truncated;
    truncated ||= summary.truncated;
    if (includeData) {
      const payload = boundedValue(job.data);
      item.data = payload.value;
      item.dataTruncated = payload.truncated;
      truncated ||= payload.truncated;
    }
    if (
      Buffer.byteLength(JSON.stringify(envelope([...jobs, item], truncated))) > MAX_INSPECTION_BYTES
    ) {
      truncated = true;
      break;
    }
    jobs.push(item);
  }
  return envelope(jobs, truncated);

  function envelope(rows: Record<string, unknown>[], isTruncated: boolean) {
    const hasMore = raw.length > rows.length;
    return {
      queue,
      state: state ?? null,
      offset,
      limit,
      jobs: rows,
      count: rows.length,
      hasMore,
      nextOffset: hasMore ? offset + rows.length : null,
      projection: includeData ? 'summary-with-data' : 'summary',
      truncated: isTruncated,
      maxBytes: MAX_INSPECTION_BYTES,
    };
  }
}
