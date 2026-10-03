/** Shared types of the job wait (`client/jobWait.ts`). */

/** A job's final outcome; `missing` marks a job that no longer exists. */
export type Outcome = { value: unknown } | { error: Error; missing?: true };

/** The command transport of a TCP Job: a TcpConnectionPool, a TcpClient, or a test double. */
export interface CommandTransport {
  send(
    command: Record<string, unknown>,
    options?: { timeout?: number }
  ): Promise<Record<string, unknown>>;
}

/** Reads a job's state once. */
export interface OutcomeReader {
  /** The final outcome, or null while the job can still change. Rejects on a read error. */
  read(): Promise<Outcome | null>;
}

/** When a wait gives up: never for an infinite deadline. */
export interface WaitLimit {
  deadline: number;
  message: string;
}

export const ENGINE_SHUT_DOWN = 'waitUntilFinished: the embedded engine was shut down';

export function commandError(response: Record<string, unknown>, fallback: string): Error {
  return new Error(typeof response.error === 'string' ? response.error : fallback);
}

/**
 * Failures that say nothing about the job and pass with time: the broker's rate
 * limit, and a command timed out or cut off while the connection is down. A later
 * read retries them; anything else (an invalid token, a closed pool) is final.
 */
const TRANSIENT_MESSAGES = new Set([
  'Rate limit exceeded',
  'Command timeout',
  'Connection lost',
  'Not connected',
]);

export function isTransientError(error: unknown): boolean {
  return error instanceof Error && TRANSIENT_MESSAGES.has(error.message);
}

/** A reply refused for a transient reason (the broker's rate limit). */
export function isTransientReply(response: Record<string, unknown>): boolean {
  return response.ok !== true && TRANSIENT_MESSAGES.has(String(response.error));
}
