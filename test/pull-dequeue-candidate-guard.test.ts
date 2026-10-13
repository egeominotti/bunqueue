/**
 * `tryDequeueNextJob` reserves the queue concurrency slot and the group slot under the
 * peeked candidate's id, then activates the job it pops
 * (`src/application/operations/pullStateTransition.ts`). peek() and pop() agree while
 * the shard lock is held; the guard covers the day they do not: the candidate's slots
 * are released, the popped (never checked) job returns to the queue unchanged, nothing
 * becomes active, the pull stops and the mismatch is logged. A fake queue whose peek
 * and pop disagree drives it.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  createDequeueScan,
  type PullContext,
  tryDequeueNextJob,
} from '../src/application/operations/pullStateTransition';
import { createJob } from '../src/domain/job/create';
import { Shard } from '../src/domain/queue/shard';
import { type Job, type JobId, jobId } from '../src/domain/types/job';
import type { JobLocation } from '../src/domain/types/queue';
import { SHARD_COUNT } from '../src/shared/hash';
import { queueLog } from '../src/shared/logger';

const QUEUE = 'dequeue-guard';
const GROUP_OPTIONS = { concurrency: 1 };

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function pullContext(jobs: Job[]): PullContext {
  const jobIndex = new Map<JobId, JobLocation>();
  for (const job of jobs) jobIndex.set(job.id, { type: 'queue', shardIdx: 0, queueName: QUEUE });
  return {
    storage: null,
    shards: [],
    shardLocks: [],
    processingShards: Array.from({ length: SHARD_COUNT }, () => new Map<JobId, Job>()),
    processingLocks: [],
    jobIndex,
    totalPulled: { value: 0n },
    broadcast: () => undefined,
  };
}

/** A shard with a queue limit of 1 whose queue answers `peek` and `pop` as given. */
function shardWithQueue(peeked: Job, popped: Job | null) {
  const shard = new Shard();
  shard.setConcurrency(QUEUE, 1);
  const pushed: Job[] = [];
  const fakeQueue = {
    peek: () => peeked,
    pop: () => popped,
    remove: () => null,
    push: (job: Job) => {
      pushed.push(job);
    },
  };
  (shard as unknown as { getQueue(queue: string): unknown }).getQueue = () => fakeQueue;
  return { shard, pushed };
}

const job = (id: string): Job => createJob(jobId(id), QUEUE, { data: { id }, groupId: 'g' });

function activeJobs(ctx: PullContext): number {
  return ctx.processingShards.reduce((total, shard) => total + shard.size, 0);
}

describe('tryDequeueNextJob candidate guard', () => {
  test('a pop that disagrees with the peek frees the slots and requeues the popped job', () => {
    const candidate = job('candidate');
    const other = job('other');
    const { shard, pushed } = shardWithQueue(candidate, other);
    const ctx = pullContext([candidate, other]);
    const errors = spyOn(queueLog, 'error').mockImplementation(() => undefined);
    spies.push(errors);

    const result = tryDequeueNextJob(
      shard,
      QUEUE,
      Date.now(),
      ctx,
      createDequeueScan(GROUP_OPTIONS)
    );

    expect(result).toEqual({ status: 'stop' });
    expect(pushed).toEqual([other]);
    expect(shard.isConcurrencyMaxed(QUEUE)).toBe(false);
    expect(shard.getGroupActiveCount(QUEUE, 'g')).toBe(0);
    expect(activeJobs(ctx)).toBe(0);
    expect(ctx.jobIndex.get(other.id)?.type).toBe('queue');
    expect(ctx.jobIndex.get(candidate.id)?.type).toBe('queue');
    expect(errors).toHaveBeenCalledTimes(1);
    // The freed slots admit the next job, under its own id.
    expect(shard.tryAcquireConcurrency(QUEUE, other.id)).toBe(true);
    expect(shard.acquireGroup(QUEUE, 'g', other.id, GROUP_OPTIONS)).toBe(true);
  });

  test('an empty pop frees the slots and requeues nothing', () => {
    const candidate = job('candidate');
    const { shard, pushed } = shardWithQueue(candidate, null);
    const ctx = pullContext([candidate]);

    const result = tryDequeueNextJob(
      shard,
      QUEUE,
      Date.now(),
      ctx,
      createDequeueScan(GROUP_OPTIONS)
    );

    expect(result).toEqual({ status: 'stop' });
    expect(pushed).toEqual([]);
    expect(shard.isConcurrencyMaxed(QUEUE)).toBe(false);
    expect(shard.getGroupActiveCount(QUEUE, 'g')).toBe(0);
  });

  test('a pop that agrees activates the job holding both slots under its id', () => {
    const candidate = job('candidate');
    const { shard, pushed } = shardWithQueue(candidate, candidate);
    const ctx = pullContext([candidate]);

    const result = tryDequeueNextJob(
      shard,
      QUEUE,
      Date.now(),
      ctx,
      createDequeueScan(GROUP_OPTIONS)
    );

    expect(result).toEqual({ status: 'job', job: candidate });
    expect(pushed).toEqual([]);
    expect(ctx.jobIndex.get(candidate.id)?.type).toBe('processing');
    expect(shard.isConcurrencyMaxed(QUEUE)).toBe(true);
    expect(shard.getGroupActiveCount(QUEUE, 'g')).toBe(1);

    shard.releaseJobResources(QUEUE, null, 'g', candidate.id);
    expect(shard.isConcurrencyMaxed(QUEUE)).toBe(false);
    expect(shard.getGroupActiveCount(QUEUE, 'g')).toBe(0);
  });
});
