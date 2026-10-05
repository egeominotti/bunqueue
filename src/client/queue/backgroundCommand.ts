/**
 * Fire-and-forget commands of the synchronous Queue methods.
 *
 * pause(), setGlobalRateLimit(), purgeDlq(), setDlqConfig(), remove(), job.discard()
 * and the other synchronous mutators cannot await their round trip, so a failure (the
 * broker unreachable, a command timeout, a pool closed before the call, an embedded
 * lock timeout) arrives after they returned. Left without a handler, that rejection was
 * unhandled, and Bun ends the process on one. Every such command runs through
 * `runInBackground`, which reports the failure instead and never throws:
 *
 * - to the owner's background-error listener when it takes the error (Simple Mode
 *   emits it on its `error` event while a listener is attached);
 * - otherwise as one `console.error` line naming the command and the queue.
 *
 * A `ClientClosedError` is not reported: the caller closed the client while the
 * command was pending, the synthetic rejection the process-wide filter ignores too.
 * The `...Async` variants are unchanged and still reject to their caller.
 * See docs/features/client-queue-sdk.md ("Background command failures").
 */

import { ClientClosedError } from '../tcp/errors';
import type { TcpConnectionPool } from '../tcpPool';

/** The failure of a fire-and-forget command, as listeners and the log receive it. */
export class BackgroundCommandError extends Error {
  /** Tags the payload like the Worker's own `error` events (`context`). */
  readonly context = 'background-command';
  /** The command that failed: a TCP command name (`Pause`, `RateLimit`...) or `add`. */
  readonly command: string;
  /** The queue it was sent for, as the broker names it (prefix included). */
  readonly queue: string;

  constructor(command: string, queue: string, cause: unknown) {
    super(`${command} for queue "${queue}" failed in the background: ${describe(cause)}`, {
      cause,
    });
    this.name = 'BackgroundCommandError';
    this.command = command;
    this.queue = queue;
  }
}

/** Takes a failure; true when it delivered it, false to have it logged instead. */
export type BackgroundErrorListener = (error: BackgroundCommandError) => boolean;

/** Who a background command belongs to and who hears about its failure. */
export interface BackgroundReporting {
  name: string;
  onBackgroundError?: BackgroundErrorListener;
}

const listeners = new WeakMap<object, BackgroundErrorListener>();

/** Route the background failures of `owner`'s commands to `listener`. */
export function setBackgroundErrorListener(owner: object, listener: BackgroundErrorListener): void {
  listeners.set(owner, listener);
}

/**
 * The `onBackgroundError` of `owner`'s operation contexts. It reads the listener when a
 * failure arrives, so one set after the command was sent still receives it.
 */
export function backgroundErrorRouter(owner: object): BackgroundErrorListener {
  return (error) => listeners.get(owner)?.(error) === true;
}

/** Emit on `emitter`'s `error` event while it has a listener; false when it has none. */
export function errorEventListener(emitter: {
  listenerCount(event: 'error'): number;
  emit(event: 'error', error: Error): boolean;
}): BackgroundErrorListener {
  return (error) => {
    if (emitter.listenerCount('error') === 0) return false;
    emitter.emit('error', error);
    return true;
  };
}

/** Send `command` without awaiting it; its failure is reported, never left unhandled. */
export function sendInBackground(
  ctx: BackgroundReporting & { tcp: TcpConnectionPool | null },
  command: Record<string, unknown> & { cmd: string }
): void {
  if (ctx.tcp) runInBackground(ctx, command.cmd, ctx.tcp.send(command));
}

/** Leave `work` running; a rejection is reported as the failure of `command`. */
export function runInBackground(
  ctx: BackgroundReporting,
  command: string,
  work: Promise<unknown>
): void {
  work.then(undefined, (cause: unknown) => reportBackgroundFailure(ctx, command, cause));
}

/** Report one failure: to the listener when it takes it, otherwise to the log. */
export function reportBackgroundFailure(
  ctx: BackgroundReporting,
  command: string,
  cause: unknown
): void {
  if (isClientClosed(cause)) return;
  const error = new BackgroundCommandError(command, ctx.name, cause);
  try {
    if (ctx.onBackgroundError?.(error) === true) return;
  } catch (listenerError) {
    log(`[bunqueue] ${error.message} (the error listener threw: ${describe(listenerError)})`);
    return;
  }
  log(`[bunqueue] ${error.message}`);
}

/** Matched by name too, so a ClientClosedError of another bunqueue copy counts. */
function isClientClosed(cause: unknown): boolean {
  if (cause instanceof ClientClosedError) return true;
  return cause instanceof Error && cause.name === 'ClientClosedError';
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
    // Reporting must never throw: a broken console cannot end the process either.
  }
}
