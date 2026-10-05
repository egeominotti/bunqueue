import type { AtomicFlowBatchInput, AtomicFlowBatchResult } from '../../domain/types/flow';
import {
  assertGroupPriority,
  assertGroupPullOptions,
  assertOptionalGroupId,
  assertPositiveSafeInteger,
  type GroupPullOptions,
} from '../../domain/types/group';
import {
  createJob,
  DEFAULT_LOCK_TTL,
  generateJobId,
  jobId,
  type Job,
  type JobId,
  type JobInput,
} from '../../domain/types/job';
import {
  assertLockDuration,
  normalizeJobInput,
  pullTimeoutArgument,
} from '../../domain/job/options';
import { validateRepeatJobInput } from '../repeatJobs';
import { PostgresQueueManagerTerminalDelivery } from './terminalDelivery';

export class PostgresQueueManagerDelivery extends PostgresQueueManagerTerminalDelivery {
  override async push(queue: string, rawInput: JobInput): Promise<Job> {
    // The base engine's stored option form (normalizeJobInput), before the group checks.
    const input = normalizeJobInput(rawInput);
    return await this.runPostgresOperation(async () => {
      await this.postgresReady;
      assertOptionalGroupId(input.groupId);
      if (input.groupId !== undefined) assertGroupPriority(input.priority);
      if (input.groupMaxSize !== undefined) {
        assertPositiveSafeInteger(input.groupMaxSize, 'group.maxSize');
      }
      validateRepeatJobInput(input);
      const id = input.customId ? jobId(input.customId) : generateJobId();
      const admitted = await this.postgresStore.insert(
        createJob(id, queue, input, await this.postgresStore.now()),
        input.groupMaxSize
      );
      await this.refreshJob(admitted.job.id, queue);
      return admitted.job;
    });
  }

  override async pushBatch(queue: string, rawInputs: JobInput[]): Promise<JobId[]> {
    const inputs = rawInputs.map(normalizeJobInput);
    return await this.runPostgresOperation(async () => {
      await this.postgresReady;
      for (const input of inputs) {
        assertOptionalGroupId(input.groupId);
        if (input.groupId !== undefined) assertGroupPriority(input.priority);
        if (input.groupMaxSize !== undefined) {
          assertPositiveSafeInteger(input.groupMaxSize, 'group.maxSize');
        }
        validateRepeatJobInput(input);
      }
      const now = await this.postgresStore.now();
      const jobs = inputs.map((input) =>
        createJob(input.customId ? jobId(input.customId) : generateJobId(), queue, input, now)
      );
      const stored = await this.postgresStore.insertMany(
        jobs,
        false,
        inputs.map((input) => input.groupMaxSize)
      );
      await this.refreshJobs(
        stored.map((job) => job.id),
        queue
      );
      return stored.map((job) => job.id);
    });
  }

  override async pushFlow(batch: AtomicFlowBatchInput): Promise<AtomicFlowBatchResult> {
    return await this.runPostgresOperation(async () => {
      await this.postgresReady;
      const jobs = await this.postgresStore.insertFlow(batch);
      await Promise.all(
        new Set(jobs.map((job) => job.queue))
          .values()
          .map((queue) => this.refreshQueueAfterCommit(queue))
      );
      return { jobs };
    });
  }

  override async pull(
    queue: string,
    timeoutMs = 0,
    signal?: AbortSignal,
    groupOptions?: GroupPullOptions
  ): Promise<Job | null> {
    // The base engine's argument rules (a clamped wait): this override does not call super.
    const claims = await this.claimUntil(
      queue,
      1,
      this.postgresStore.config.brokerId,
      pullTimeoutArgument(timeoutMs),
      undefined,
      signal,
      groupOptions
    );
    return claims[0]?.job ?? null;
  }

  // oxlint-disable-next-line max-params -- public API includes cancellation and lease policy
  override async pullWithLock(
    queue: string,
    owner: string,
    timeoutMs = 0,
    lockTtl = DEFAULT_LOCK_TTL,
    signal?: AbortSignal,
    groupOptions?: GroupPullOptions
  ): Promise<{ job: Job | null; token: string | null }> {
    assertLockDuration(lockTtl, 'lockTtl');
    const wait = pullTimeoutArgument(timeoutMs);
    const claims = await this.claimUntil(queue, 1, owner, wait, lockTtl, signal, groupOptions);
    const claim = claims[0];
    return claim ? { job: claim.job, token: claim.token } : { job: null, token: null };
  }

  override async pullBatch(
    queue: string,
    count: number,
    timeoutMs = 0,
    signal?: AbortSignal,
    groupOptions?: GroupPullOptions
  ): Promise<Job[]> {
    const claims = await this.claimUntil(
      queue,
      count,
      this.postgresStore.config.brokerId,
      pullTimeoutArgument(timeoutMs),
      undefined,
      signal,
      groupOptions
    );
    return claims.map((claim) => claim.job);
  }

  // oxlint-disable-next-line max-params -- public API includes cancellation and lease policy
  override async pullBatchWithLock(
    queue: string,
    count: number,
    owner: string,
    timeoutMs = 0,
    lockTtl = DEFAULT_LOCK_TTL,
    signal?: AbortSignal,
    groupOptions?: GroupPullOptions
  ): Promise<{ jobs: Job[]; tokens: string[] }> {
    assertLockDuration(lockTtl, 'lockTtl');
    const claims = await this.claimUntil(
      queue,
      count,
      owner,
      pullTimeoutArgument(timeoutMs),
      lockTtl,
      signal,
      groupOptions
    );
    return {
      jobs: claims.map((claim) => claim.job),
      tokens: claims.map((claim) => claim.token),
    };
  }

  // oxlint-disable-next-line max-params -- internal bridge mirrors the public pull contract
  private async claimUntil(
    queue: string,
    count: number,
    owner: string,
    timeoutMs: number,
    leaseDurationMs?: number,
    signal?: AbortSignal,
    groupOptions?: GroupPullOptions
  ) {
    assertGroupPullOptions(groupOptions);
    await this.postgresReady;
    await this.flushPostgresWrites();
    // As in the core engine, a NaN or non-positive timeout is a single attempt.
    const waitMs = timeoutMs > 0 ? timeoutMs : 0;
    const deadline = Date.now() + waitMs;
    do {
      const claims = await this.runPostgresOperation(async () => {
        const admitted = await this.postgresStore.claim(
          queue,
          count,
          owner,
          leaseDurationMs,
          groupOptions
        );
        for (const claim of admitted) {
          this.applyPostgresClaim(claim);
        }
        return admitted;
      });
      if (claims.length > 0 || waitMs === 0 || signal?.aborted) return claims;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return [];
      await this.postgresStore.waitForWork(
        queue,
        Math.min(remaining, this.postgresStore.config.pollIntervalMs),
        signal
      );
    } while (!signal?.aborted);
    return [];
  }
}
