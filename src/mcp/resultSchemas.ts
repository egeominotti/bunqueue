/** Public schemas for the structured envelope and common legacy payloads. */
import { z } from 'zod';

export const ERROR_CODES = [
  'not_found',
  'invalid_input',
  'rejected_transition',
  'cancelled',
  'backend_unavailable',
  'provider_unavailable',
  'confirmation_required',
  'unknown',
] as const;
export type ToolErrorCode = (typeof ERROR_CODES)[number];

const object = z.record(z.string(), z.unknown());
const legacyError = z.object({ error: z.string() }).passthrough();
const counts = z
  .object({
    waiting: z.number(),
    prioritized: z.number(),
    delayed: z.number(),
    active: z.number(),
    completed: z.number(),
    failed: z.number(),
    paused: z.number(),
    'waiting-children': z.number(),
  })
  .passthrough();
const booleanResult = z.object({ success: z.boolean() }).passthrough();
const booleanTools = new Set(
  [
    'cancel_job',
    'promote_job',
    'update_progress',
    'update_job_data',
    'change_job_priority',
    'move_to_delayed',
    'discard_job',
    'change_delay',
    'add_job_log',
    'remove_webhook',
    'set_webhook_enabled',
    'delete_cron',
    'unregister_worker',
    'worker_heartbeat',
    'job_heartbeat',
    'extend_lock',
    'unregister_handler',
  ].map((name) => `bunqueue_${name}`)
);

function dataSchema(name: string) {
  let payload: z.ZodTypeAny;
  if (booleanTools.has(name)) payload = booleanResult;
  else if (name === 'bunqueue_add_job') payload = z.object({ jobId: z.string() }).passthrough();
  else if (name === 'bunqueue_get_job_counts' || name === 'bunqueue_get_queue_stats')
    payload = counts;
  else if (name === 'bunqueue_get_job_state')
    payload = z.object({ jobId: z.string(), state: z.string() }).passthrough();
  else if (name === 'bunqueue_wait_for_job')
    payload = z.object({ jobId: z.string(), completed: z.boolean() }).passthrough();
  else if (name === 'bunqueue_get_prometheus_metrics') payload = z.object({ text: z.string() });
  else
    payload = z.union([
      object,
      z.array(z.unknown()),
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
    ]);
  // Missing targets, guard previews and refusals use their unchanged legacy object.
  return z.union([payload, legacyError]);
}

export function resultSchemaShape(name: string) {
  return {
    outcome: z.enum(['success', 'not_applied', 'confirmation_required', 'error']),
    data: dataSchema(name),
    error: z
      .object({
        code: z.enum(ERROR_CODES),
        message: z.string(),
        retryable: z.boolean(),
        outcomeUncertain: z.boolean().optional(),
      })
      .optional(),
    suggestedAction: z.string().optional(),
  };
}
