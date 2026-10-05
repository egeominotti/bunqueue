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
}

/**
 * Renew every pulled job's lease each `intervalMs` (> 0, validated as the Worker's
 * `heartbeatInterval`). `safeInterval` honours an interval above the native timer limit
 * instead of letting the runtime fire it every millisecond.
 */
export function startHeartbeat(deps: HeartbeatDeps, intervalMs: number): SafeTimer {
  return safeInterval(() => void sendHeartbeat(deps), intervalMs);
}

export async function sendHeartbeat(deps: HeartbeatDeps): Promise<void> {
  // Send heartbeat for ALL pulled jobs (including buffered ones)
  // This is critical: when locks are enabled, we need to renew them
  // even for jobs sitting in the buffer waiting to be processed
  if (deps.pulledJobIds.size === 0 || !deps.tcp) return;

  try {
    // Always take a fresh snapshot - avoids race with job start/complete
    const ids = Array.from(deps.pulledJobIds);
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
    const error = err instanceof Error ? err : new Error(String(err));
    deps.emitter.emit('error', Object.assign(error, { context: 'heartbeat' }));
  }
}
