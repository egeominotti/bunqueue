/** One read of a job's state, from the embedded manager or over TCP. */

import { lastFailedReason } from '../../domain/job/terminal';
import { jobId } from '../../domain/types/job';
import { peekSharedManager, type SharedManager } from '../manager';
import {
  commandError,
  ENGINE_SHUT_DOWN,
  type CommandTransport,
  type Outcome,
  type OutcomeReader,
} from './types';

const FAILED_FALLBACK = 'Job already failed';

/**
 * The job no longer exists: it was removed (remove, drain, obliterate, clean, DLQ
 * purge), or removed on completion or failure before the wait saw that event. Its
 * outcome is unknown, so the wait reports neither a result nor a failure reason.
 */
export function missingJob(id: string): Outcome {
  return { error: new Error(`Job ${id} not found`), missing: true };
}

/** Reads `manager` only while it is the live shared manager; it never creates one. */
export function managerReader(manager: SharedManager, id: string): OutcomeReader {
  const key = jobId(id);
  const shutDown = (): Outcome => ({ error: new Error(ENGINE_SHUT_DOWN) });
  const alive = () => peekSharedManager() === manager;

  async function readState(): Promise<Outcome | null> {
    const state = await manager.getJobState(key);
    if (state === 'completed') return { value: manager.getResult(key) };
    if (state === 'failed') {
      const job = await manager.getJob(key);
      return { error: new Error((job ? lastFailedReason(job) : undefined) ?? FAILED_FALLBACK) };
    }
    return state === 'unknown' ? missingJob(id) : null;
  }

  return {
    async read() {
      if (!alive()) return shutDown();
      try {
        const outcome = await readState();
        // A shutdown during the read empties the manager: what it said is not the job's.
        return alive() ? outcome : shutDown();
      } catch (error) {
        if (!alive()) return shutDown();
        throw error;
      }
    },
  };
}

/** Reads over TCP; a refused GetState (for example an invalid token) is an error. */
export function brokerReader(tcp: CommandTransport, id: string): OutcomeReader {
  return {
    async read() {
      const response = await tcp.send({ cmd: 'GetState', id });
      if (response.ok !== true) throw commandError(response, 'Failed to read job state');
      const { state } = response;
      if (state === 'completed') {
        const result = await tcp.send({ cmd: 'GetResult', id });
        if (result.ok !== true) throw commandError(result, 'Failed to read job result');
        return { value: result.result };
      }
      if (state === 'failed') {
        // The state is decisive; the reason is best effort (the job can be purged meanwhile).
        const reply = await tcp.send({ cmd: 'GetJob', id });
        const reason = (reply.job as { failedReason?: unknown } | null | undefined)?.failedReason;
        return { error: new Error(typeof reason === 'string' ? reason : FAILED_FALLBACK) };
      }
      return state === 'unknown' ? missingJob(id) : null;
    },
  };
}
