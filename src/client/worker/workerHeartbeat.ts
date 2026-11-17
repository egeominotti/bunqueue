/**
 * WorkerHeartbeat - Heartbeat sending for TCP worker connections
 * Sends periodic heartbeats to keep locks alive and prevent stall detection
 */

import type { EventEmitter } from 'events';
import { safeInterval, type SafeTimer } from '../../shared/timers';
import type { TcpConnection } from './types';

export interface HeartbeatDeps {
  readonly pulledJobIds: Set<string>;
  readonly jobTokens: Map<string, string>;
  readonly tcp: TcpConnection | null;
  readonly useLocks: boolean;
  readonly emitter: EventEmitter;
  /** True for a failure that is not reported (the Worker's own close rejecting it). */
  readonly isExpectedFailure?: (error: unknown) => boolean;
}

/** Recompute eligible delivery IDs on each tick, including after a pause or resume. */
export function startHeartbeat(
  deps: HeartbeatDeps,
  intervalMs: number,
  jobIds?: () => Iterable<string>
): SafeTimer {
  return safeInterval(() => void sendHeartbeat(deps, jobIds?.()), intervalMs);
}

export async function sendHeartbeat(
  deps: HeartbeatDeps,
  jobIds: Iterable<string> = deps.pulledJobIds
): Promise<void> {
  if (deps.pulledJobIds.size === 0 || !deps.tcp) return;

  try {
    // Always take a fresh snapshot - avoids race with job start/complete
    const ids = Array.from(jobIds);
    if (ids.length === 0) return;

    if (deps.useLocks) {
      // With locks: include tokens for lock renewal
      const tokens = ids.map((id) => deps.jobTokens.get(id) ?? '');
      if (ids.length === 1) {
        await deps.tcp.send({ cmd: 'JobHeartbeat', id: ids[0], token: tokens[0] || undefined });
      } else {
        await deps.tcp.send({ cmd: 'JobHeartbeatB', ids, tokens });
      }
    } else {
      // Without locks: simple heartbeat for stall detection only
      if (ids.length === 1) {
        await deps.tcp.send({ cmd: 'JobHeartbeat', id: ids[0] });
      } else {
        await deps.tcp.send({ cmd: 'JobHeartbeatB', ids });
      }
    }
  } catch (err) {
    if (deps.isExpectedFailure?.(err)) return;
    const error = err instanceof Error ? err : new Error(String(err));
    deps.emitter.emit('error', Object.assign(error, { context: 'heartbeat' }));
  }
}
