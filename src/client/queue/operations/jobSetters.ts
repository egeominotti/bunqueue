/**
 * Queue job setters: changeJobDelay, changeJobPriority and extendJobLock. Each checks its
 * argument or the broker's reply the same way in both modes, so embedded and TCP give
 * the same outcome.
 */
import { getSharedManager } from '../../manager';
import type { TcpConnectionPool } from '../../tcpPool';
import { jobId } from '../../../domain/types/job';
import {
  assertDelayChanged,
  assertJobDelay,
  assertLockExtension,
  assertPriorityChanged,
  lockExtensionResult,
} from '../commandArgs';

interface TimingContext {
  embedded: boolean;
  tcp: TcpConnectionPool | null;
}

function connection(ctx: TimingContext): TcpConnectionPool {
  if (!ctx.tcp) throw new Error('Queue has no TCP connection');
  return ctx.tcp;
}

/** Change job delay */
export async function changeJobDelay(ctx: TimingContext, id: string, delay: number): Promise<void> {
  assertJobDelay(delay);
  // A job that cannot be changed (gone, active, finished) is not changed in both modes,
  // as on 2.9.10; an invalid delay throws.
  if (ctx.embedded) {
    await getSharedManager().changeDelay(jobId(id), delay);
    return;
  }
  assertDelayChanged(await connection(ctx).send({ cmd: 'ChangeDelay', id, delay }));
}

/** Change job priority (the broker applies the PUSH rule of the job's own kind) */
export async function changeJobPriority(
  ctx: TimingContext,
  id: string,
  opts: { priority: number; lifo?: boolean }
): Promise<void> {
  if (ctx.embedded) {
    await getSharedManager().changePriority(jobId(id), opts.priority, opts.lifo);
    return;
  }
  const response = await connection(ctx).send({
    cmd: 'ChangePriority',
    id,
    priority: opts.priority,
    lifo: opts.lifo,
  });
  assertPriorityChanged(response);
}

/** Extend job lock */
export async function extendJobLock(
  ctx: TimingContext,
  id: string,
  token: string,
  duration: number
): Promise<number> {
  assertLockExtension(duration);
  if (ctx.embedded) {
    const success = await getSharedManager().extendLock(jobId(id), token, duration);
    return success ? duration : 0;
  }
  const response = await connection(ctx).send({ cmd: 'ExtendLock', id, token, duration });
  return lockExtensionResult(response, duration);
}
