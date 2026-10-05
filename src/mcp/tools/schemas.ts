/**
 * Shared zod field schemas for MCP tool inputs.
 *
 * The numeric bounds mirror the broker's job-option validation (TCP protocol and
 * atomic flows), so a call rejected over TCP is rejected the same way in embedded
 * mode instead of silently creating a job the broker would refuse. Fields the broker
 * does not bound (custom ids, deduplication, tags, lock owner/TTL) get an MCP-side
 * bound, applied identically in both modes because zod runs before either backend.
 */

import { z } from 'zod';
import { MAX_BACKOFF_DELAY } from '../../domain/job/constants';
import { isWellFormedJobId } from '../../domain/job/ids';

const MAX_PRIORITY = 1_000_000;
const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 1000;
/** Bound of `timeout` and `stallTimeout` in the broker's validateJobOptions (24 hours). */
const MAX_PROCESSING_MS = 24 * 60 * 60 * 1000;
/** Bound of a job id in the broker's atomic-flow validation, reused for every custom id. */
const MAX_ID_LENGTH = 1024;
const MAX_TAG_LENGTH = 256;
const MIN_LOCK_MS = 1000;

/** A queue name: never empty (an empty name would silently create a queue named ""). */
export function queueField(description = 'Queue name') {
  return z.string().min(1).describe(description);
}

/** A job name/type: never empty. */
export function jobNameField(description = 'Job name/type') {
  return z.string().min(1).describe(description);
}

/** Job priority: an integer within the broker's accepted range. */
export function priorityField(description = 'Priority (higher = processed first)') {
  return z.number().int().min(-MAX_PRIORITY).max(MAX_PRIORITY).describe(description);
}

/** A new delay for an existing job (move to delayed, change delay), in ms: 0 to one year. */
export function delayField(description = 'Delay in milliseconds before processing') {
  return z.number().min(0).max(MAX_DELAY_MS).describe(description);
}

/**
 * The `delay` option of a job being added, in ms: at most one year (this tool's own
 * limit). A negative delay (a run time already in the past) is accepted: the job is ready
 * at once with that past run time, as the broker stores it.
 */
export function jobDelayField(
  description = 'Delay in milliseconds before processing (a negative delay makes the job ready at once)'
) {
  return z.number().max(MAX_DELAY_MS).describe(description);
}

/** Maximum attempts: an integer of at least 1. */
export function attemptsField(description = 'Max attempts, including the first (default: 3)') {
  return z.number().int().min(1).max(MAX_ATTEMPTS).describe(description);
}

/** Retry backoff: a base delay, or an explicit fixed/exponential strategy. */
export function backoffField() {
  const ms = z.number().min(0).max(MAX_BACKOFF_DELAY);
  return z
    .union([
      ms,
      z.object({
        type: z.enum(['fixed', 'exponential']),
        delay: ms.describe('Base delay in ms'),
        maxDelay: ms.optional().describe('Cap of one retry delay in ms (default: 1 hour)'),
      }),
    ])
    .describe(
      'Retry backoff in ms: a number is an exponential base (retry n waits about base × 2^n, capped at 1 hour; default 1000), or { type: "fixed" | "exponential", delay, maxDelay? }'
    );
}

/** Processing timeout of an active job (0 to 24 hours). */
export function timeoutField() {
  return z
    .number()
    .min(0)
    .max(MAX_PROCESSING_MS)
    .describe('Processing timeout in ms; an attempt that runs longer fails and is retried');
}

/** Per-job stall window (0 to 24 hours). */
export function stallTimeoutField() {
  return z
    .number()
    .min(0)
    .max(MAX_PROCESSING_MS)
    .describe(
      'Ms without a heartbeat before this active job counts as stalled (default: server setting)'
    );
}

/**
 * An identifier string: 1 to 1024 characters of well-formed Unicode. A lone surrogate
 * would be rejected by the embedded engine but rewritten to U+FFFD on the TCP wire, so
 * it is refused here for both modes.
 */
function identifierField() {
  return z
    .string()
    .min(1)
    .max(MAX_ID_LENGTH)
    .refine(isWellFormedJobId, { message: 'must be well-formed Unicode' });
}

/** A custom job id: it becomes the job's own id. */
export function customJobIdField(description: string) {
  return identifierField().describe(description);
}

/** Unique-key deduplication within a queue. */
export function deduplicationField() {
  return z
    .object({
      id: identifierField().describe('Deduplication key (scoped to the queue)'),
      ttl: z
        .number()
        .min(1)
        .max(MAX_DELAY_MS)
        .optional()
        .describe('Key lifetime in ms (default: until its job finishes)'),
      extend: z
        .boolean()
        .optional()
        .describe('Restart the ttl on a duplicate of a waiting or delayed job (requires ttl)'),
      replace: z
        .boolean()
        .optional()
        .describe('Add this job anyway and remove a waiting or delayed holder of the key'),
    })
    .refine((dedup) => !dedup.extend || dedup.ttl !== undefined, {
      message: 'deduplication.extend requires deduplication.ttl',
    })
    .describe(
      'Deduplicate within the queue: while the job holding the key is pending or active, an add with the same key returns its id'
    );
}

/** Free-form labels stored on the job. */
export function tagsField() {
  return z
    .array(
      z
        .string()
        .max(MAX_TAG_LENGTH)
        .refine(isWellFormedJobId, { message: 'must be well-formed Unicode' })
    )
    .describe('Labels stored on the job');
}

/**
 * Add options shared by bunqueue_add_job and every item of bunqueue_add_jobs_bulk.
 * Both backends map each field to the same engine input (src/mcp/backend/jobOptions.ts).
 */
export function jobOptionsShape() {
  return {
    priority: priorityField().optional(),
    delay: jobDelayField().optional(),
    attempts: attemptsField().optional(),
    backoff: backoffField().optional(),
    timeout: timeoutField().optional(),
    jobId: customJobIdField(
      'Custom job id (server-wide). Idempotent: while that job is unfinished, adding it again returns the same id'
    ).optional(),
    deduplication: deduplicationField().optional(),
    removeOnComplete: z.boolean().optional().describe('Delete the job once it completes'),
    removeOnFail: z
      .boolean()
      .optional()
      .describe('Delete the job instead of moving it to the DLQ when it finally fails'),
    durable: z
      .boolean()
      .optional()
      .describe('Write to disk before returning, bypassing the 10 ms write buffer'),
    lifo: z.boolean().optional().describe('Run before older ready jobs of the same priority'),
    tags: tagsField().optional(),
    stallTimeout: stallTimeoutField().optional(),
  };
}

/** Lock owner for a manual pull: setting it makes the broker issue a lock token. */
export function lockOwnerField() {
  return z
    .string()
    .min(1)
    .max(MAX_TAG_LENGTH)
    .describe(
      'Lock owner: pulled jobs are locked and returned with a token that ack, fail and heartbeat must pass'
    );
}

/** A lock lifetime in ms (1 second to 24 hours): pull lockTtl and extend_lock duration. */
export function lockTtlField(description = 'Lock lifetime in ms (default: 30000; requires owner)') {
  return z.number().min(MIN_LOCK_MS).max(MAX_PROCESSING_MS).describe(description);
}

/** A lock token returned by a pull with an owner. */
export function lockTokenField(description: string) {
  return z.string().min(1).describe(description);
}
