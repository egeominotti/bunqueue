import type { Job } from '../../types';
import { removeJobDeduplicationKey } from '../../jobDeduplication';
import { waitJobUntilFinished } from '../../jobWait';
import { buildFailCommand } from '../failWire';
import {
  assertJobDelay,
  assertDelayChanged,
  assertLockExtension,
  assertLogsCleared,
  assertPriorityChanged,
  assertProgressUpdated,
  assertPromoted,
  delayUntil,
  lockExtensionResult,
  progressUpdate,
} from '../commandArgs';
import type { JobProxyContext, JobReflectionMeta } from '../types/job';
import { sendInBackground } from '../backgroundCommand';
import { computeDependencies } from './dependencies';
import { reflectFields } from './reflection';
import { serializeReturnvalue } from '../jobMetadata';

function assertMoveResponse(response: Record<string, unknown>, operation: string): void {
  if (response.ok === true) return;
  throw new Error(typeof response.error === 'string' ? response.error : `${operation} failed`);
}

/** Create a full Job proxy whose methods use the TCP transport. */
export function createJobProxy<T>(
  id: string,
  name: string,
  data: T,
  ctx: JobProxyContext,
  meta?: JobReflectionMeta
): Job<T> {
  const { tcp, queueName } = ctx;
  const timestamp = meta?.timestamp ?? Date.now();
  const reflected = reflectFields(id, queueName, meta);
  const attemptsMade = meta?.attemptsMade ?? 0;
  const attemptsStarted = meta?.attemptsStarted ?? attemptsMade;
  const progress = meta?.progress ?? 0;
  const stalledCounter = meta?.stalledCounter ?? 0;

  return {
    id,
    name,
    data,
    queueName,
    attemptsMade,
    timestamp,
    progress,
    delay: reflected.delay,
    processedOn: meta?.processedOn,
    finishedOn: meta?.finishedOn,
    stacktrace: reflected.stacktrace,
    returnvalue: reflected.returnvalue,
    failedReason: reflected.failedReason,
    stalledCounter,
    priority: reflected.priority,
    parent: reflected.parent,
    parentKey: reflected.parentKey,
    opts: reflected.opts,
    token: undefined,
    processedBy: undefined,
    deduplicationId: reflected.deduplicationId,
    repeatJobKey: reflected.repeatJobKey,
    attemptsStarted,
    updateProgress: async (progress: number, message?: string) => {
      const update = progressUpdate(progress, message);
      assertProgressUpdated(await tcp.send({ cmd: 'Progress', id, ...update }));
    },
    log: async (message: string) => {
      await tcp.send({ cmd: 'AddLog', id, message });
    },
    getState: () => ctx.getJobState(id),
    remove: () => ctx.removeAsync(id),
    retry: () => ctx.retryJob(id),
    getChildrenValues: <R = unknown>() => ctx.getChildrenValues(id) as Promise<Record<string, R>>,
    isWaiting: async () => (await ctx.getJobState(id)) === 'waiting',
    isActive: async () => (await ctx.getJobState(id)) === 'active',
    isDelayed: async () => (await ctx.getJobState(id)) === 'delayed',
    isCompleted: async () => (await ctx.getJobState(id)) === 'completed',
    isFailed: async () => (await ctx.getJobState(id)) === 'failed',
    isWaitingChildren: async () => (await ctx.getJobState(id)) === 'waiting-children',
    updateData: async (newData) => {
      assertMoveResponse(await tcp.send({ cmd: 'Update', id, data: newData }), 'Update');
    },
    promote: async () => {
      assertPromoted(await tcp.send({ cmd: 'Promote', id }));
    },
    changeDelay: async (delay) => {
      assertJobDelay(delay);
      assertDelayChanged(await tcp.send({ cmd: 'ChangeDelay', id, delay }));
    },
    changePriority: async (opts) => {
      assertPriorityChanged(
        await tcp.send({ cmd: 'ChangePriority', id, priority: opts.priority, lifo: opts.lifo })
      );
    },
    extendLock: async (token, duration) => {
      assertLockExtension(duration);
      const response = await tcp.send({ cmd: 'ExtendLock', id, token, duration });
      return lockExtensionResult(response, duration);
    },
    // keepLogs used to be dropped here, so clearLogs(n) cleared every entry over TCP.
    clearLogs: async (keepLogs?: number) => {
      assertLogsCleared(await tcp.send({ cmd: 'ClearLogs', id, keepLogs }));
    },
    getDependencies: () => computeDependencies(id, queueName, tcp),
    getDependenciesCount: async () => {
      const dependencies = await computeDependencies(id, queueName, tcp);
      return {
        processed: Object.keys(dependencies.processed).length,
        unprocessed: dependencies.unprocessed.length,
      };
    },
    toJSON: () => ({
      id,
      name,
      data,
      opts: reflected.opts,
      progress,
      delay: reflected.delay,
      timestamp,
      attemptsMade,
      stacktrace: reflected.stacktrace,
      returnvalue: reflected.returnvalue,
      failedReason: reflected.failedReason,
      processedOn: meta?.processedOn,
      finishedOn: meta?.finishedOn,
      queueQualifiedName: `bull:${queueName}`,
      parentKey: reflected.parentKey,
    }),
    asJSON: () => ({
      id,
      name,
      data: JSON.stringify(data),
      opts: JSON.stringify(reflected.opts),
      progress: String(progress),
      delay: String(reflected.delay),
      timestamp: String(timestamp),
      attemptsMade: String(attemptsMade),
      stacktrace: reflected.stacktrace ? JSON.stringify(reflected.stacktrace) : null,
      returnvalue: serializeReturnvalue(reflected.returnvalue),
      failedReason: reflected.failedReason,
      processedOn: meta?.processedOn === undefined ? undefined : String(meta.processedOn),
      finishedOn: meta?.finishedOn === undefined ? undefined : String(meta.finishedOn),
      parentKey: reflected.parentKey,
    }),
    moveToCompleted: async (returnValue, token) => {
      assertMoveResponse(
        await tcp.send({
          cmd: 'ACK',
          id,
          result: returnValue,
          ...(token === undefined ? {} : { token }),
        }),
        'ACK'
      );
      return null;
    },
    moveToFailed: async (error, token) => {
      assertMoveResponse(await tcp.send(buildFailCommand(id, error, token)), 'FAIL');
    },
    moveToWait: async (token) => {
      const response = await tcp.send({
        cmd: 'MoveToWait',
        id,
        ...(token === undefined ? {} : { token }),
      });
      if (response.ok === false && /token/i.test(String(response.error))) {
        assertMoveResponse(response, 'MoveToWait');
      }
      return response.ok === true;
    },
    moveToDelayed: async (targetTimestamp, token) => {
      const delay = delayUntil(targetTimestamp);
      assertMoveResponse(
        await tcp.send({
          cmd: 'MoveToDelayed',
          id,
          delay,
          ...(token === undefined ? {} : { token }),
        }),
        'MoveToDelayed'
      );
    },
    moveToWaitingChildren: async (token) => {
      const response = await tcp.send({
        cmd: 'MoveToWaitingChildren',
        id,
        ...(token === undefined ? {} : { token }),
      });
      if (response.ok === false && /token/i.test(String(response.error))) {
        assertMoveResponse(response, 'MoveToWaitingChildren');
      }
      return response.ok === true;
    },
    waitUntilFinished: (queueEvents, ttl) => waitJobUntilFinished({ tcp }, id, queueEvents, ttl),
    discard: () => {
      // Not awaited (sync API); a failure is reported by backgroundCommand.ts.
      sendInBackground({ name: queueName, tcp }, { cmd: 'Discard', id });
    },
    getFailedChildrenValues: async () => {
      const response = await tcp.send({ cmd: 'GetFailedChildrenValues', id });
      return (response.values as Record<string, string> | undefined) ?? {};
    },
    getIgnoredChildrenFailures: async () => {
      const response = await tcp.send({ cmd: 'GetIgnoredChildrenFailures', id });
      return (response.values as Record<string, string> | undefined) ?? {};
    },
    removeChildDependency: async () => {
      const response = await tcp.send({ cmd: 'RemoveChildDependency', id });
      return (response.removed as boolean | undefined) ?? false;
    },
    removeDeduplicationKey: () => removeJobDeduplicationKey(id, false, tcp),
    removeUnprocessedChildren: async () => {
      await tcp.send({ cmd: 'RemoveUnprocessedChildren', id });
    },
  };
}
