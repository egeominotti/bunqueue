/** One read of a job's state, from the embedded manager or over TCP. */

import { lastFailedReason } from '../../domain/job/terminal';
import { jobId } from '../../domain/types/job';
import { peekSharedManager, type SharedManager } from '../manager';
import {
  commandError,
  ENGINE_SHUT_DOWN,
  isTransientReply,
  type CommandTransport,
  type Outcome,
  type OutcomeReader,
} from './types';

const FAILED_FALLBACK = 'Job already failed';

/**
 * The job no longer exists: it was removed (remove, drain, obliterate, clean, DLQ
 * purge), or removed on completion or failure before the wait saw that event, and the
 * engine retains no completion for it. Its outcome is unknown, so the wait reports
 * neither a result nor a failure reason. (A job removed on completion whose result the
 * engine still retains settles on that result instead: see `managerReader` and
 * `brokerReader`.)
 */
export function missingJob(id: string): Outcome {
  return { error: new Error(`Job ${id} not found`), missing: true };
}

/**
 * Reads `manager` only while it is the live shared manager; it never creates one.
 *
 * A job that reads as `unknown` may have been removed on completion while the engine
 * still retains its result (memory only, for a short time): before settling as missing
 * the read asks the engine's completion lookup, as `brokerReader` does over TCP.
 */
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
    if (state !== 'unknown') return null;
    const completion = await manager.getCompletionAsync(key);
    return completion.found ? { value: completion.result } : missingJob(id);
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

/**
 * Reads over TCP; a refused GetState (for example an invalid token) is an error.
 *
 * A job that reads as `unknown` may have been removed on completion while the broker
 * still holds its result (PostgreSQL keeps a completion tombstone). A WaitJob hold on
 * that broker returns it, so before settling as missing the read asks the same lookup
 * (WaitJob with a 0 ms hold): the outcome depends on the broker's state only, not on
 * whether a hold or a read reaches it first, nor on when this wait's first read was
 * served. Memory and SQLite retain the result for a short, bounded time (memory only,
 * `removedResults`), after which such a job reads as missing there.
 */
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
      return state === 'unknown' ? await retainedCompletion(tcp, id) : null;
    },
  };
}

/** The broker's completion lookup for a job that is gone: its result, or missing. */
async function retainedCompletion(tcp: CommandTransport, id: string): Promise<Outcome | null> {
  const reply = await tcp.send({ cmd: 'WaitJob', id, timeout: 0 });
  if (reply.ok === true && reply.completed === true) return { value: reply.result };
  // A job back under the same id (custom-ID reuse) is still running.
  if (reply.ok === true && reply.completed === false) return null;
  if (isTransientReply(reply)) throw commandError(reply, 'Failed to read job result');
  return missingJob(id);
}
