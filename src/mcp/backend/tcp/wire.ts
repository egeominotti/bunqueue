/**
 * Broker reply handling for the MCP TCP backend. The TCP client resolves every reply,
 * including `ok: false` rejections, so each command goes through `assertOk`, which turns
 * a rejection into a thrown error that carries the broker's own message.
 */

export type WireReply = Record<string, unknown>;

/** A command the broker answered with `ok: false`. */
export class BrokerError extends Error {
  readonly command: string;

  constructor(command: string, message: string) {
    super(message);
    this.name = 'BrokerError';
    this.command = command;
  }
}

/** Returns the reply unchanged, or throws a BrokerError when the broker rejected it. */
export function assertOk(command: Record<string, unknown>, reply: WireReply): WireReply {
  if (reply.ok !== false) return reply;
  const cmd = String(command.cmd);
  const message =
    typeof reply.error === 'string' && reply.error.length > 0 ? reply.error : `${cmd} failed`;
  throw new BrokerError(cmd, message);
}

/**
 * Rejections that report a negative domain outcome rather than a failure: the target job,
 * lock, cron, webhook or worker does not exist, or is not in a state the operation accepts.
 * Matched phrases: "not found" (also "Job not found or cannot be cancelled / be updated /
 * change delay"), "not active" ("Job is not active (current state: completed)"), "not
 * delayed", "not in queue", "invalid token" ("Lock not found or invalid token") and
 * "Cannot move job from state '<state>' to waiting". A bare "cannot" is deliberately not
 * matched: it also appears in forwarded JavaScript runtime errors ("Cannot read properties
 * of undefined ...") and validation errors ("A job cannot be its own parent").
 * Authentication, validation, unknown command and internal errors never match.
 */
const NEGATIVE_OUTCOME =
  /\bnot found\b|\bnot active\b|\bnot delayed\b|\bnot in queue\b|\binvalid token\b|\bcannot move job from state\b/i;

/** True when `error` is a broker rejection that means "no such target / wrong state". */
export function isNegativeOutcome(error: unknown): boolean {
  return error instanceof BrokerError && NEGATIVE_OUTCOME.test(error.message);
}

/** True when `error` is a broker rejection that means the target does not exist. */
export function isNotFound(error: unknown): boolean {
  return error instanceof BrokerError && /\bnot found\b/i.test(error.message);
}

/** The `data` envelope of a reply built with the broker's `data()` builder. */
export function replyData(reply: WireReply): Record<string, unknown> {
  const data = reply.data;
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

/** A finite number from a reply field, or 0. */
export function numberField(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
