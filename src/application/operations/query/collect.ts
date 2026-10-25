import type { Shard } from '../../../domain/queue/shard';
import type { Job } from '../../../domain/types/job';
import { appendAll } from '../../../shared/arrays';
import { compareSqliteBinaryText } from '../../../shared/serialization';
import type { GetJobsContext } from '../../types/query';

export function compareJobsByCreatedAt(a: Job, b: Job, asc: boolean): number {
  if (a.createdAt !== b.createdAt) {
    return asc ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
  }
  const byId = compareSqliteBinaryText(String(a.id), String(b.id));
  return asc ? byId : -byId;
}

function collectCompletedJobs(queue: string, ctx: GetJobsContext): Job[] {
  const jobs: Job[] = [];
  for (const [jobId, location] of ctx.jobIndex) {
    if (location.type === 'completed' && location.queueName === queue) {
      const job = ctx.storage?.getJob(jobId) ?? ctx.completedJobsData?.get(jobId) ?? null;
      if (job) jobs.push(job);
    }
  }
  return jobs;
}

function collectActiveJobs(queue: string, shardIndex: number, ctx: GetJobsContext): Job[] {
  const jobs: Job[] = [];
  for (const job of ctx.processingShards[shardIndex].values()) {
    if (job.queue === queue) jobs.push(job);
  }
  for (let index = 0; index < ctx.shardCount; index++) {
    if (index === shardIndex) continue;
    for (const job of ctx.processingShards[index].values()) {
      if (job.queue === queue) jobs.push(job);
    }
  }
  return jobs;
}

export function collectTemporalJobs(
  shard: Shard,
  queue: string,
  needs: { waiting: boolean; prioritized: boolean; delayed: boolean },
  now: number = Date.now(),
  tagTemporal = false
): Job[] {
  const { waiting: needWaiting, prioritized: needPrioritized, delayed: needDelayed } = needs;
  const jobs: Job[] = [];
  // One pass over the queue (no intermediate copies); with `tagTemporal`, each collected
  // job also gets its temporal `_state` here instead of in a second pass.
  shard.getQueue(queue).forEachJob((job) => {
    const isDelayed = job.runAt > now;
    if (isDelayed ? needDelayed : job.priority > 0 ? needPrioritized : needWaiting) {
      if (tagTemporal) {
        (job as unknown as Record<string, unknown>)._state = isDelayed
          ? 'delayed'
          : job.priority > 0
            ? 'prioritized'
            : 'waiting';
      }
      jobs.push(job);
    }
  });
  return jobs;
}

export function tagState(jobs: Job[], state: string): Job[] {
  for (const job of jobs) (job as unknown as Record<string, unknown>)._state = state;
  return jobs;
}

export function collectWaitingChildrenJobs(shard: Shard, queue: string): Job[] {
  const jobs: Job[] = [];
  for (const job of shard.waitingDeps.values()) {
    if (job.queue === queue) jobs.push(job);
  }
  for (const job of shard.waitingChildren.values()) {
    if (job.queue === queue) jobs.push(job);
  }
  return jobs;
}

interface StateNeeds {
  waiting: boolean;
  prioritized: boolean;
  delayed: boolean;
  paused: boolean;
  active: boolean;
  failed: boolean;
  completed: boolean;
  waitingChildren: boolean;
}

function resolveStateNeeds(states: string[] | null, paused: boolean): StateNeeds {
  const want = (state: string): boolean => !states || states.includes(state);
  const suppressReady = !!states && paused;
  return {
    waiting: want('waiting') && !suppressReady,
    prioritized: want('prioritized') && !suppressReady,
    delayed: want('delayed'),
    paused: !!states && states.includes('paused') && paused,
    active: want('active'),
    failed: want('failed'),
    completed: want('completed'),
    waitingChildren: want('waiting-children'),
  };
}

function collectPausedJobs(shard: Shard, queue: string, now: number): Job[] {
  const jobs = collectTemporalJobs(
    shard,
    queue,
    { waiting: true, prioritized: true, delayed: false },
    now
  );
  return tagState(jobs, 'paused');
}

export function collectJobsByState(
  queue: string,
  shardIndex: number,
  states: string[] | null,
  ctx: GetJobsContext,
  now: number = Date.now()
): Job[] {
  const shard = ctx.shards[shardIndex];
  const needs = resolveStateNeeds(states, shard.getState(queue).paused);

  // The temporal jobs come first, so their array is the result array itself.
  const jobs: Job[] =
    needs.waiting || needs.prioritized || needs.delayed
      ? collectTemporalJobs(
          shard,
          queue,
          { waiting: needs.waiting, prioritized: needs.prioritized, delayed: needs.delayed },
          now,
          true
        )
      : [];
  if (needs.paused) appendAll(jobs, collectPausedJobs(shard, queue, now));
  if (needs.active) appendAll(jobs, tagState(collectActiveJobs(queue, shardIndex, ctx), 'active'));
  if (needs.failed) appendAll(jobs, tagState(shard.getDlq(queue), 'failed'));
  if (needs.completed) appendAll(jobs, tagState(collectCompletedJobs(queue, ctx), 'completed'));
  if (needs.waitingChildren) {
    appendAll(jobs, tagState(collectWaitingChildrenJobs(shard, queue), 'waiting-children'));
  }
  return jobs;
}
