import type {
  ClearLogsCommand,
  CompactMemoryCommand,
  ExtendLockCommand,
  ExtendLocksCommand,
  PrometheusCommand,
} from '../../../../domain/types/command';
import { jobId, type JobId } from '../../../../domain/types/job';
import type { Response } from '../../../../domain/types/response';
import * as response from '../../../../domain/types/response';
import { LOCK_NOT_EXTENDED_ERROR } from '../../../../domain/job/options';
import { validateKeepLogs, validateLockDuration } from '../../protocol/validation';
import type { HandlerContext } from '../../types';

export function handlePrometheus(
  _command: PrometheusCommand,
  context: HandlerContext,
  requestId?: string
): Response {
  return response.data({ metrics: context.queueManager.getPrometheusMetrics() }, requestId);
}

export function handleClearLogs(
  command: ClearLogsCommand,
  context: HandlerContext,
  requestId?: string
): Response | Promise<Response> {
  // Checked here too so the PostgreSQL path (clearLogsDurable) applies the same bound.
  const keepLogsError = validateKeepLogs(command.keepLogs);
  if (keepLogsError) return response.error(keepLogsError, requestId);
  const id = jobId(command.id);
  const manager = context.queueManager as typeof context.queueManager & {
    clearLogsDurable?: (id: JobId, keepLogs?: number) => Promise<void>;
  };
  if (manager.clearLogsDurable) {
    return manager
      .clearLogsDurable(id, command.keepLogs)
      .then(() => response.ok(undefined, requestId));
  }
  manager.clearLogs(id, command.keepLogs);
  return response.ok(undefined, requestId);
}

export async function handleExtendLock(
  command: ExtendLockCommand,
  context: HandlerContext,
  requestId?: string
): Promise<Response> {
  const durationError = validateLockDuration(command.duration, 'duration');
  if (durationError) return response.error(durationError, requestId);
  const success = await context.queueManager.extendLock(
    jobId(command.id),
    command.token ?? null,
    command.duration ?? undefined
  );
  return success
    ? response.ok(undefined, requestId)
    : response.error(LOCK_NOT_EXTENDED_ERROR, requestId);
}

export async function handleExtendLocks(
  command: ExtendLocksCommand,
  context: HandlerContext,
  requestId?: string
): Promise<Response> {
  // Validate every duration before extending any lease (an invalid one rejects the batch).
  for (let index = 0; index < command.ids.length; index++) {
    const error = validateLockDuration(command.durations?.[index], 'duration');
    if (error) return response.error(`durations[${index}]: ${error}`, requestId);
  }
  let count = 0;
  for (let index = 0; index < command.ids.length; index++) {
    const success = await context.queueManager.extendLock(
      jobId(command.ids[index]),
      command.tokens[index] ?? null,
      command.durations?.[index] ?? undefined
    );
    if (success) count++;
  }
  return { ok: true, count, reqId: requestId };
}

export function handleCompactMemory(
  _command: CompactMemoryCommand,
  context: HandlerContext,
  requestId?: string
): Response {
  context.queueManager.compactMemory();
  return response.ok(undefined, requestId);
}
