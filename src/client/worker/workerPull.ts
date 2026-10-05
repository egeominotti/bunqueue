/**
 * WorkerPull - Job pulling functions for embedded and TCP modes
 * Handles batch pulling with optional lock-based ownership
 */

import { getSharedManager } from '../manager';
import type { Job as InternalJob } from '../../domain/types/job';
import { LOCK_TIMEOUT_MESSAGES, LockTimeoutError } from '../../shared/lockError';
import { isTransientError, isTransientReply } from '../job-wait/types';
import type { TcpConnection } from './types';
import type { GroupWorkerOptions } from '../types';
import { parseJobFromResponse } from './jobParser';

/**
 * The broker refused a PULL or PULLB (`ok: false`): a validation error, a missing auth
 * token, the protocol rate limit. It is never an empty queue, which is `ok: true` with
 * no job. `transient` marks a refusal that passes with time (see `isTransientRefusal`).
 */
export class PullRefusedError extends Error {
  readonly command: string;
  readonly reason: string;
  readonly transient: boolean;

  constructor(command: string, response: Record<string, unknown>) {
    const reason = typeof response.error === 'string' ? response.error : 'no reason given';
    super(`${command} refused by the broker: ${reason}`);
    this.name = 'PullRefusedError';
    this.command = command;
    this.reason = reason;
    this.transient = isTransientRefusal(response);
  }
}

/**
 * A refusal that passes with time: the broker's protocol rate limit (the same replies
 * the job wait retries, `job-wait/types.ts`), a shard lock wait that outlasted
 * LOCK_TIMEOUT_MS under contention (`shared/lockError.ts`, returned verbatim), or a
 * storage failure the broker redacts to `Internal server error` (a busy database, a
 * PostgreSQL broker shutting down).
 */
export function isTransientRefusal(response: Record<string, unknown>): boolean {
  return (
    isTransientReply(response) ||
    response.error === 'Internal server error' ||
    (typeof response.error === 'string' && LOCK_TIMEOUT_MESSAGES.has(response.error))
  );
}

/**
 * A pull failure that passes with time: a transient refusal (TCP), the shard lock
 * timeout an embedded pull throws itself under contention (`LockTimeoutError`), or a
 * command that timed out or was cut off while the connection is down. The Worker and
 * the SandboxedWorker report it only to an attached `error` listener, so it never
 * crashes one that has none.
 */
export function isTransientPullError(error: unknown): boolean {
  if (error instanceof PullRefusedError) return error.transient;
  return error instanceof LockTimeoutError || isTransientError(error);
}

export interface PullConfig {
  readonly name: string;
  readonly workerId: string;
  readonly useLocks: boolean;
  readonly pollTimeout: number;
  /** Lock TTL in ms to request from the server on a lock-based pull. */
  readonly lockDuration?: number;
  readonly group?: GroupWorkerOptions;
}

export async function pullEmbedded(
  config: PullConfig,
  count: number
): Promise<Array<{ job: InternalJob; token: string | null }>> {
  const manager = getSharedManager();

  // Use lock-based pull only when useLocks is enabled. Pass lockDuration so the
  // configured lock TTL is honored in embedded mode too (undefined → server default).
  if (config.useLocks) {
    if (count === 1) {
      const { job, token } = await manager.pullWithLock(
        config.name,
        config.workerId,
        0,
        config.lockDuration,
        undefined,
        config.group
      );
      return job ? [{ job, token }] : [];
    }
    const { jobs, tokens } = await manager.pullBatchWithLock(
      config.name,
      count,
      config.workerId,
      0,
      config.lockDuration,
      undefined,
      config.group
    );
    return jobs.map((job, i) => ({ job, token: tokens[i] || null }));
  }

  // No locks - use regular pull
  if (count === 1) {
    const job = await manager.pull(config.name, 0, undefined, config.group);
    return job ? [{ job, token: null }] : [];
  }
  const jobs = await manager.pullBatch(config.name, count, 0, undefined, config.group);
  return jobs.map((job) => ({ job, token: null }));
}

export async function pullTcp(
  config: PullConfig,
  tcp: TcpConnection,
  count: number,
  closing: boolean
): Promise<Array<{ job: InternalJob; token: string | null }>> {
  if (closing) return [];

  // Build pull command - only request locks if useLocks is enabled.
  // `count` belongs to the batch PULLB; a single PULL doesn't need it.
  const cmd: Record<string, unknown> = {
    cmd: count === 1 ? 'PULL' : 'PULLB',
    queue: config.name,
    timeout: config.pollTimeout,
  };
  if (count > 1) cmd.count = count;
  if (config.group) cmd.group = config.group;

  // Only request lock ownership when useLocks is enabled
  if (config.useLocks) {
    cmd.owner = config.workerId;
    // Propagate the configured lock TTL so the server doesn't always fall back
    // to its 30s default (WorkerOptions.lockDuration was previously ignored).
    if (config.lockDuration !== undefined) cmd.lockTtl = config.lockDuration;
  }

  const response = await tcp.send(cmd);

  // A refusal is a pull error, not an empty queue: reading it as one hid a
  // misconfigured Worker behind silent idle polling and false `drained` events.
  if (response.ok !== true) throw new PullRefusedError(String(cmd.cmd), response);

  if (count === 1) {
    const job = response.job as Record<string, unknown> | null | undefined;
    // Only expect token if locks are enabled
    const token = config.useLocks ? ((response.token as string | null | undefined) ?? null) : null;
    if (job) {
      return [{ job: parseJobFromResponse(job, config.name), token }];
    }
    return [];
  }

  const jobs = response.jobs as Array<Record<string, unknown>> | undefined;
  // Only expect tokens if locks are enabled
  const tokens = config.useLocks ? ((response.tokens as string[] | undefined) ?? []) : [];
  return (
    jobs?.map((j, i) => ({
      job: parseJobFromResponse(j, config.name),
      token: tokens[i] || null,
    })) ?? []
  );
}
