/**
 * The messages of a lock wait that ran out (`AsyncLock`, `RWLock`). The broker returns
 * them verbatim to a refused command, and a Worker reads them as a refusal that passes
 * with time (`client/worker/workerPull.ts`): keep the wording here, in one place.
 */
export const LOCK_TIMEOUT_MESSAGE = 'Lock acquisition timed out';
export const READ_LOCK_TIMEOUT_MESSAGE = 'Read lock acquisition timed out';
export const WRITE_LOCK_TIMEOUT_MESSAGE = 'Write lock acquisition timed out';

export const LOCK_TIMEOUT_MESSAGES: ReadonlySet<string> = new Set([
  LOCK_TIMEOUT_MESSAGE,
  READ_LOCK_TIMEOUT_MESSAGE,
  WRITE_LOCK_TIMEOUT_MESSAGE,
]);

export class LockTimeoutError extends Error {
  constructor(message: string = LOCK_TIMEOUT_MESSAGE) {
    super(message);
    this.name = 'LockTimeoutError';
  }
}
