/**
 * How a Worker or SandboxedWorker reports a failed pull, so that no report can end the
 * process or alert on what 2.9.10 kept quiet.
 *
 * - A transient refusal (`isQuietPullFailure`: the broker's rate limit, a lock timeout,
 *   a redacted `Internal server error`) is not reported at all: on 2.9.10 a refused
 *   pull looked like an empty queue, so an app alerting on every `error` never heard
 *   of it. The pull loops read it as an empty pull and keep their empty-pull cadence
 *   (Worker `doPullBatch`, SandboxedWorker `pullOnce`), with no growing backoff.
 * - Any other failure goes to an attached `error` listener. A listener that throws is
 *   caught and its own failure logged (at most once a minute), never rethrown: from the
 *   pull loop it would be one unhandled rejection per failed pull.
 * - Without a listener, EventEmitter would throw the `error`, and from the pull loop
 *   that surfaced as an unhandled rejection that could end the whole process (which may
 *   host other healthy Workers or an HTTP server). A permanent failure (a wrong token,
 *   an invalid queue name, a rejected option) is written to the console instead, naming
 *   the worker, the queue and the reason, on the first failure and then at most once
 *   per `PULL_FAILURE_LOG_INTERVAL_MS`; a transient thrown error (a timeout, a lost
 *   connection) stays quiet.
 */

import { isTransientPullError, PullRefusedError } from './workerPull';

/** At most one line per worker and kind in this window (a minute). */
export const PULL_FAILURE_LOG_INTERVAL_MS = 60_000;

/** A transient broker refusal: 2.9.10 read it as an empty queue, so it is not reported. */
export function isQuietPullFailure(error: unknown): boolean {
  return error instanceof PullRefusedError && error.transient;
}

/** The empty pull a transient refusal is read as (SandboxedWorker `ops.pull`). */
export const QUIET_PULL = Object.freeze({ job: null, token: null });

/** `QUIET_PULL` for a transient refusal, as 2.9.10 read it; rethrow anything else. */
export function quietPullOrThrow(error: unknown): typeof QUIET_PULL {
  if (isQuietPullFailure(error)) return QUIET_PULL;
  throw error;
}

interface Emitter {
  listenerCount(event: 'error'): number;
  emit(event: 'error', error: Error): boolean;
}

export class PullFailureLog {
  private lastFailureAt = Number.NEGATIVE_INFINITY;
  private lastListenerFailureAt = Number.NEGATIVE_INFINITY;

  /**
   * Report `error` of `owner` (e.g. `Worker "emails"`) through `emitter` as described
   * above. Never throws.
   */
  report(owner: string, emitter: Emitter, error: Error): void {
    if (isQuietPullFailure(error)) return;
    if (emitter.listenerCount('error') === 0) {
      if (!isTransientPullError(error) && this.due('failure')) {
        log(
          `[bunqueue] ${owner}: pull failed: ${error.message}. Retrying with backoff ` +
            "(100 ms to 30 s); listen to 'error' to handle it. Logged at most once a minute."
        );
      }
      return;
    }
    try {
      emitter.emit('error', error);
    } catch (listenerError) {
      if (this.due('listener')) {
        log(
          `[bunqueue] ${owner}: pull failed: ${error.message} (the error listener threw: ` +
            `${describe(listenerError)}). Logged at most once a minute.`
        );
      }
    }
  }

  private due(kind: 'failure' | 'listener'): boolean {
    const now = performance.now();
    const last = kind === 'failure' ? this.lastFailureAt : this.lastListenerFailureAt;
    if (now - last < PULL_FAILURE_LOG_INTERVAL_MS) return false;
    if (kind === 'failure') this.lastFailureAt = now;
    else this.lastListenerFailureAt = now;
    return true;
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return String(value);
  } catch {
    return 'unknown error';
  }
}

function log(line: string): void {
  try {
    console.error(line);
  } catch {
    // Reporting must never throw: a broken console cannot stop the pull loop.
  }
}
