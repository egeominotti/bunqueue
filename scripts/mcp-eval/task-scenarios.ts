import type { McpBackend } from '../../src/mcp/adapter';
import type { CallRecord, ScenarioId, TaskCheck } from './task-types';

export const TASK_SCENARIOS: Array<{ id: ScenarioId; request: string }> = [
  {
    id: 'complete',
    request:
      'Process the queued task locally, retain its null result and report verified completion.',
  },
  {
    id: 'terminal',
    request:
      'Report permanent failure, and distinguish the missing job from a successful completion.',
  },
  {
    id: 'pages',
    request:
      'Read every waiting job using summary pages of at most two rows; reject a limit of 101 without changing state.',
  },
  {
    id: 'diagnose',
    request:
      'Explain observed queue constraints and exact accounting; do not infer consumer availability or root cause.',
  },
  {
    id: 'guard',
    request:
      'Preview queue deletion without approval. Report confirmation required and leave all jobs intact.',
  },
];

export async function seedScenario(id: ScenarioId, backend: McpBackend, queue: string) {
  const jobIds: string[] = [];
  const count = id === 'pages' ? 5 : id === 'guard' ? 2 : 1;
  for (let i = 0; i < count; i++) {
    const job = await backend.addJob(queue, `task-${i}`, { private: 'eval-private-payload' });
    jobIds.push(job.jobId);
  }
  if (id === 'terminal') {
    await backend.pullJob(queue);
    await backend.failJob(jobIds[0], 'eval permanent failure', { unrecoverable: true });
  }
  if (id === 'diagnose') {
    await backend.addJob(queue, 'delayed', {}, { delay: 3600000 });
    await backend.setConcurrency(queue, 1);
    await backend.pauseQueue(queue);
  }
  return jobIds;
}

/** Grade actual tool responses plus a separate backend read, never a driver's success flag. */
export async function verifyScenario(
  id: ScenarioId,
  backend: McpBackend,
  queue: string,
  jobIds: string[],
  calls: CallRecord[]
): Promise<TaskCheck[]> {
  const checks: TaskCheck[] = [];
  const check = (name: string, passed: boolean) => checks.push({ name, passed });
  const counts = await backend.getJobCounts(queue);
  const replies = (name: string) => calls.filter((call) => call.name === name);
  const observations = replies('bunqueue_observe_job');
  if (id === 'complete') {
    check(
      'completed result independently retained',
      (await backend.getJobState(jobIds[0])) === 'completed' &&
        (await backend.getJobResult(jobIds[0])) === null
    );
    check(
      'completion accounting',
      counts.completed === 1 && counts.active === 0 && counts.waiting === 0
    );
    check(
      'terminal completion observed',
      observations.some(
        ({ reply, args }) =>
          args.jobId === jobIds[0] &&
          reply.outcome === 'success' &&
          reply.data.state === 'completed' &&
          reply.data.terminal === true &&
          reply.data.result === null
      )
    );
  } else if (id === 'terminal') {
    check(
      'permanent failure independently retained',
      (await backend.getJobState(jobIds[0])) === 'failed' &&
        counts.failed === 1 &&
        counts.active === 0
    );
    check(
      'failed terminal observed',
      observations.some(
        ({ reply, args }) =>
          args.jobId === jobIds[0] &&
          reply.data.state === 'failed' &&
          reply.data.terminal === true &&
          Boolean(reply.data.failure)
      )
    );
    check(
      'unknown never implies success',
      observations.some(
        ({ reply, args }) =>
          args.jobId === `${queue}-missing` &&
          reply.data.state === 'unknown' &&
          reply.data.terminal === false &&
          !('result' in reply.data)
      )
    );
  } else if (id === 'pages') {
    const pages = replies('bunqueue_list_jobs_page').filter(
      ({ reply }) => reply.outcome === 'success'
    );
    const rows = pages.flatMap(
      ({ reply }) => (reply.data.jobs as Array<{ id: string }> | undefined) ?? []
    );
    const returnedIds = rows.map((job) => job.id);
    check(
      'all seeded IDs exactly once',
      returnedIds.length === jobIds.length &&
        new Set(returnedIds).size === jobIds.length &&
        jobIds.every((jobId) => returnedIds.includes(jobId))
    );
    check(
      'bounded complete offset chain',
      pages.length === 3 &&
        pages.every(
          ({ args, reply }, i) =>
            args.limit === 2 &&
            args.offset === i * 2 &&
            reply.data.count === (i === 2 ? 1 : 2) &&
            reply.data.hasMore === i < 2 &&
            reply.data.nextOffset === (i < 2 ? (i + 1) * 2 : null)
        )
    );
    check(
      'summary does not reveal payload',
      pages.length > 0 &&
        pages.every(
          ({ reply }) =>
            !JSON.stringify(reply).includes('eval-private-payload') &&
            reply.data.projection === 'summary'
        )
    );
    check(
      'oversized limit refused',
      replies('bunqueue_list_jobs_page').some(
        ({ args, reply }) => args.limit === 101 && reply.isError
      )
    );
    check(
      'paging preserves real queue',
      counts.waiting === 5 && counts.active === 0 && counts.completed === 0
    );
  } else if (id === 'diagnose') {
    const diagnosis = replies('bunqueue_diagnose_queue')[0]?.reply.data;
    const limits = await backend.getQueueLimits(queue);
    check('actual limits remain configured', limits.paused && limits.concurrencyLimit === 1);
    check(
      'exact state accounting',
      counts.paused === 1 &&
        counts.delayed === 1 &&
        diagnosis?.total === 2 &&
        JSON.stringify(diagnosis?.counts) === JSON.stringify(counts)
    );
    check(
      'accurate blockers without invented cause',
      Boolean(
        diagnosis &&
        JSON.stringify(diagnosis.blockers) === JSON.stringify(['paused', 'delayed_jobs']) &&
        diagnosis.cause === 'unknown' &&
        !JSON.stringify(diagnosis).includes('no_workers')
      )
    );
  } else {
    const guarded = replies('bunqueue_obliterate_queue')[0]?.reply;
    check(
      'preview requires confirmation',
      guarded?.outcome === 'confirmation_required' &&
        guarded.isError &&
        guarded.data.executed === false
    );
    check(
      'no approval supplied',
      calls.every(({ args }) => !('confirm' in args))
    );
    check(
      'all jobs independently intact',
      counts.waiting === jobIds.length &&
        counts.active === 0 &&
        (await Promise.all(jobIds.map((jobId) => backend.getJobState(jobId)))).every(
          (state) => state === 'waiting'
        )
    );
  }
  return checks;
}
