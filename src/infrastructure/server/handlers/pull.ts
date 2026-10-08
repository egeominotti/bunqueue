/**
 * PULL / PULLB handlers and the shutdown-drain rule for pulls.
 */

import type { Command } from '../../../domain/types/command';
import type { Response } from '../../../domain/types/response';
import * as resp from '../../../domain/types/response';
import { validateGroupPullOptions } from '../../../domain/types/group';
import { pullTimeoutArgument } from '../../../domain/job/options';
import { safeTimeout } from '../../../shared/timers';
import type { HandlerContext } from '../types';
import {
  validateLockDuration,
  validateNumericField,
  validatePullTimeout,
  validateQueueName,
} from '../protocol';

/**
 * A pull that came back empty while the server drains its shutdown. The drain hands
 * out no job (the transport's pull signal aborts), so the empty answer would return at
 * once and a long-polling worker would re-poll in a tight loop: the SDK waits only
 * 10 ms after an empty long poll. Such a pull instead holds, still delivering nothing,
 * until its own timeout or until its connection ends (the client goes away, or the
 * server's `stop()` closes it). A pull without a timeout answers at once, as for an
 * empty queue, and one whose own client is gone is not held.
 */
async function holdEmptyPullWhileDraining(
  ctx: HandlerContext,
  startedAt: number,
  timeout: unknown
): Promise<void> {
  if (!ctx.drainSignal?.aborted) return;
  const connection = ctx.connectionSignal;
  const remaining = startedAt + pullTimeoutArgument(timeout) - Date.now();
  if (remaining <= 0 || connection?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      timer.clear();
      connection?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = safeTimeout(finish, remaining);
    connection?.addEventListener('abort', finish, { once: true });
  });
}

export async function handlePull(
  cmd: Extract<Command, { cmd: 'PULL' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const queueError = validateQueueName(cmd.queue);
  if (queueError) return resp.error(queueError, reqId);

  const timeoutError = validatePullTimeout(cmd.timeout);
  if (timeoutError) return resp.error(timeoutError, reqId);
  const pullError =
    validateGroupPullOptions(cmd.group) ?? validateLockDuration(cmd.lockTtl, 'lockTtl');
  if (pullError) return resp.error(pullError, reqId);
  const startedAt = Date.now();

  if (cmd.owner) {
    const { job, token } = await ctx.queueManager.pullWithLock(
      cmd.queue,
      cmd.owner,
      cmd.timeout,
      cmd.lockTtl ?? undefined,
      ctx.signal,
      cmd.group
    );
    if (job && ctx.clientId) {
      ctx.queueManager.registerClientJob(ctx.clientId, job.id);
    }
    if (!job) await holdEmptyPullWhileDraining(ctx, startedAt, cmd.timeout);
    return resp.pulledJob(job, token, reqId);
  }

  // Standard pull (no lock, but still track for client release unless detached)
  const job = await ctx.queueManager.pull(cmd.queue, cmd.timeout, ctx.signal, cmd.group);
  if (job && ctx.clientId && !cmd.detach) {
    ctx.queueManager.registerClientJob(ctx.clientId, job.id);
  }
  if (!job) await holdEmptyPullWhileDraining(ctx, startedAt, cmd.timeout);
  return resp.nullableJob(job, reqId);
}

export async function handlePullBatch(
  cmd: Extract<Command, { cmd: 'PULLB' }>,
  ctx: HandlerContext,
  reqId?: string
): Promise<Response> {
  const queueError = validateQueueName(cmd.queue);
  if (queueError) return resp.error(queueError, reqId);

  const countError = validateNumericField(cmd.count, 'count', { min: 1, max: 1000 });
  if (countError) return resp.error(countError, reqId);

  const timeoutError = validatePullTimeout(cmd.timeout);
  if (timeoutError) return resp.error(timeoutError, reqId);
  const pullError =
    validateGroupPullOptions(cmd.group) ?? validateLockDuration(cmd.lockTtl, 'lockTtl');
  if (pullError) return resp.error(pullError, reqId);
  const startedAt = Date.now();

  if (cmd.owner) {
    const { jobs, tokens } = await ctx.queueManager.pullBatchWithLock(
      cmd.queue,
      cmd.count,
      cmd.owner,
      cmd.timeout ?? 0,
      cmd.lockTtl ?? undefined,
      ctx.signal,
      cmd.group
    );
    if (ctx.clientId) {
      for (const job of jobs) {
        ctx.queueManager.registerClientJob(ctx.clientId, job.id);
      }
    }
    if (jobs.length === 0) await holdEmptyPullWhileDraining(ctx, startedAt, cmd.timeout);
    return resp.pulledJobs(jobs, tokens, reqId);
  }

  // Standard pull (no locks, but still track for client release) — the
  // non-owner branch honors cmd.timeout exactly like the owner branch and PULL.
  const jobs = await ctx.queueManager.pullBatch(
    cmd.queue,
    cmd.count,
    cmd.timeout ?? 0,
    ctx.signal,
    cmd.group
  );
  if (ctx.clientId) {
    for (const job of jobs) {
      ctx.queueManager.registerClientJob(ctx.clientId, job.id);
    }
  }
  if (jobs.length === 0) await holdEmptyPullWhileDraining(ctx, startedAt, cmd.timeout);
  return resp.jobs(jobs, reqId);
}
