import { jobId } from '../../domain/types/job';
import { getFlowDependencies } from '../flowJobDependencies';
import type { PublicJobMethodContext } from '../jobConversionTypes';
import { getSharedManager } from '../manager';
import { removeJobDeduplicationKey } from '../jobDeduplication';
import { waitJobUntilFinished } from '../jobWait';
import type { TcpConnectionPool } from '../tcpPool';
import { buildFailCommand, failEmbeddedArgs } from './failWire';
import {
  assertDelayChanged,
  assertJobDelay,
  assertLockExtension,
  assertPriorityChanged,
  assertProgressUpdated,
  assertPromoted,
  delayUntil,
  lockExtensionResult,
  progressUpdate,
  requireDataUpdated,
} from './commandArgs';
import type { SimpleJobContext } from './jobProxy';
import { runInBackground, sendInBackground, type BackgroundReporting } from './backgroundCommand';

export interface DlqJobContext
  extends
    Pick<SimpleJobContext, 'getJobState' | 'removeAsync' | 'retryJob' | 'getChildrenValues'>,
    BackgroundReporting {
  name: string;
  embedded: boolean;
  tcp: TcpConnectionPool | null;
}

function assertCommand(response: Record<string, unknown>, operation: string): void {
  if (response.ok === true) return;
  throw new Error(typeof response.error === 'string' ? response.error : `${operation} failed`);
}

export function createDlqJobMethods(ctx: DlqJobContext): PublicJobMethodContext {
  const manager = () => getSharedManager();
  const send = async (command: Record<string, unknown>, operation: string) => {
    if (!ctx.tcp) throw new Error(`${operation}: no connection`);
    const response = await ctx.tcp.send(command);
    assertCommand(response, operation);
    return response;
  };
  const dependencies = (id: string) => getFlowDependencies(id, ctx.name, ctx.embedded, ctx.tcp);

  return {
    updateProgress: async (id, progress, message) => {
      // A job that is not active is not updated, in both modes; other rejections throw.
      const update = progressUpdate(progress, message);
      if (ctx.embedded) {
        await manager().updateProgress(jobId(id), update.progress, update.message);
      } else {
        if (!ctx.tcp) throw new Error('Progress: no connection');
        assertProgressUpdated(await ctx.tcp.send({ cmd: 'Progress', id, ...update }));
      }
    },
    log: async (id, message) => {
      if (ctx.embedded) manager().addLog(jobId(id), message);
      else await send({ cmd: 'AddLog', id, message }, 'AddLog');
    },
    getState: ctx.getJobState,
    remove: ctx.removeAsync,
    retry: ctx.retryJob,
    getChildrenValues: ctx.getChildrenValues,
    updateData: async (id, data) => {
      if (ctx.embedded) requireDataUpdated(await manager().updateJobData(jobId(id), data));
      else await send({ cmd: 'Update', id, data }, 'Update');
    },
    promote: async (id) => {
      if (ctx.embedded) await manager().promote(jobId(id));
      else {
        if (!ctx.tcp) throw new Error('Promote: no connection');
        assertPromoted(await ctx.tcp.send({ cmd: 'Promote', id }));
      }
    },
    changeDelay: async (id, delay) => {
      // A job that cannot be changed is not changed (2.9.10); an invalid delay throws.
      assertJobDelay(delay);
      if (ctx.embedded) await manager().changeDelay(jobId(id), delay);
      else {
        if (!ctx.tcp) throw new Error('ChangeDelay: no connection');
        assertDelayChanged(await ctx.tcp.send({ cmd: 'ChangeDelay', id, delay }));
      }
    },
    changePriority: async (id, options) => {
      if (ctx.embedded) await manager().changePriority(jobId(id), options.priority, options.lifo);
      else {
        if (!ctx.tcp) throw new Error('ChangePriority: no connection');
        assertPriorityChanged(
          await ctx.tcp.send({
            cmd: 'ChangePriority',
            id,
            priority: options.priority,
            lifo: options.lifo,
          })
        );
      }
    },
    extendLock: async (id, token, duration) => {
      assertLockExtension(duration);
      if (ctx.embedded)
        return (await manager().extendLock(jobId(id), token, duration)) ? duration : 0;
      if (!ctx.tcp) throw new Error('ExtendLock: no connection');
      const response = await ctx.tcp.send({ cmd: 'ExtendLock', id, token, duration });
      return lockExtensionResult(response, duration);
    },
    clearLogs: async (id, keepLogs) => {
      if (ctx.embedded) manager().clearLogs(jobId(id), keepLogs);
      else await send({ cmd: 'ClearLogs', id, keepLogs }, 'ClearLogs');
    },
    getDependencies: async (id) => dependencies(id),
    getDependenciesCount: async (id) => {
      const value = await dependencies(id);
      return {
        processed: Object.keys(value.processed).length,
        unprocessed: value.unprocessed.length,
      };
    },
    moveToCompleted: async (id, result, token) => {
      if (ctx.embedded) await manager().ack(jobId(id), result, token);
      else await send({ cmd: 'ACK', id, result, token }, 'ACK');
      return null;
    },
    moveToFailed: async (id, error, token) => {
      if (ctx.embedded) await manager().fail(jobId(id), ...failEmbeddedArgs(error, token));
      else await send(buildFailCommand(id, error, token), 'FAIL');
    },
    moveToWait: async (id, token) => {
      if (ctx.embedded) {
        const state = await manager().getJobState(jobId(id));
        if (state === 'failed') return manager().retryDlq(ctx.name, jobId(id)) > 0;
        if (state === 'active') return manager().moveActiveToWait(jobId(id), token);
        if (state === 'delayed') return manager().promote(jobId(id));
        return state === 'waiting' || state === 'prioritized';
      }
      const response = await send(
        { cmd: 'MoveToWait', id, ...(token === undefined ? {} : { token }) },
        'MoveToWait'
      );
      return response.ok === true;
    },
    moveToDelayed: async (id, timestamp, token) => {
      const delay = delayUntil(timestamp);
      if (ctx.embedded) await manager().moveToDelayed(jobId(id), delay, token);
      else {
        await send(
          { cmd: 'MoveToDelayed', id, delay, ...(token === undefined ? {} : { token }) },
          'MoveToDelayed'
        );
      }
    },
    moveToWaitingChildren: async (id, token) => {
      if (ctx.embedded) return manager().moveToWaitingChildren(jobId(id), token);
      await send(
        { cmd: 'MoveToWaitingChildren', id, ...(token === undefined ? {} : { token }) },
        'MoveToWaitingChildren'
      );
      return true;
    },
    waitUntilFinished: (id, queueEvents, ttl) => waitJobUntilFinished(ctx, id, queueEvents, ttl),
    discard: (id) => {
      // Not awaited (sync API); a failure is reported by backgroundCommand.ts.
      if (ctx.embedded) runInBackground(ctx, 'Discard', manager().discard(jobId(id)));
      else sendInBackground(ctx, { cmd: 'Discard', id });
    },
    getFailedChildrenValues: async (id) => {
      if (ctx.embedded) return manager().getFailedChildrenValues(jobId(id));
      const response = await send(
        { cmd: 'GetFailedChildrenValues', id },
        'GetFailedChildrenValues'
      );
      return (response.values as Record<string, string> | undefined) ?? {};
    },
    getIgnoredChildrenFailures: async (id) => {
      if (ctx.embedded) return manager().getIgnoredChildrenFailures(jobId(id));
      const response = await send(
        { cmd: 'GetIgnoredChildrenFailures', id },
        'GetIgnoredChildrenFailures'
      );
      return (response.values as Record<string, string> | undefined) ?? {};
    },
    removeChildDependency: async (id) => {
      if (ctx.embedded) return manager().removeChildDependency(jobId(id));
      const response = await send({ cmd: 'RemoveChildDependency', id }, 'RemoveChildDependency');
      return (response.removed as boolean | undefined) ?? false;
    },
    removeDeduplicationKey: (id) => removeJobDeduplicationKey(id, ctx.embedded, ctx.tcp),
    removeUnprocessedChildren: async (id) => {
      if (ctx.embedded) await manager().removeUnprocessedChildren(jobId(id));
      else await send({ cmd: 'RemoveUnprocessedChildren', id }, 'RemoveUnprocessedChildren');
    },
  };
}
