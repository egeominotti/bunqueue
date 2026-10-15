import type { JobCounts, McpBackend } from './types/adapter';
import { listJobsPage } from './inspectionPage';

export function totalJobs(counts: JobCounts) {
  return (
    counts.waiting +
    counts.prioritized +
    counts.delayed +
    counts.active +
    counts.completed +
    counts.failed +
    counts.paused +
    (counts['waiting-children'] ?? 0)
  );
}

/** Observed constraints only. A non-atomic snapshot cannot establish a root cause. */
export async function diagnoseQueue(backend: McpBackend, queue: string) {
  const observedAt = new Date().toISOString();
  const [counts, limits, active, delayed, children] = await Promise.all([
    backend.getJobCounts(queue),
    backend.getQueueLimits(queue),
    listJobsPage(backend, { queue, state: 'active', limit: 5 }),
    listJobsPage(backend, { queue, state: 'delayed', limit: 5 }),
    listJobsPage(backend, { queue, state: 'waiting-children', limit: 5 }),
  ]);
  const blockers: string[] = [];
  if (limits.paused) blockers.push('paused');
  if (limits.rateLimited) blockers.push('rate_limited');
  if (limits.concurrencyMaxed) blockers.push('concurrency_maxed');
  if (counts.delayed > 0) blockers.push('delayed_jobs');
  if ((counts['waiting-children'] ?? 0) > 0) blockers.push('waiting_children');
  return {
    queue,
    observedAt,
    counts,
    total: totalJobs(counts),
    limits,
    blockers,
    samples: { active, delayed, 'waiting-children': children },
    cause: 'unknown',
    caveat:
      'Non-atomic snapshot: growth, stalls, starvation and consumer availability require additional evidence.',
    suggestedTools: [
      'bunqueue_get_queue_limits',
      'bunqueue_list_jobs_page',
      'bunqueue_observe_job',
    ],
  };
}
