export function validateQueueName(name: string): string | null {
  if (!name || name.length === 0) return 'Queue name is required';
  if (name.length > 256) return 'Queue name too long (max 256 characters)';
  if (!/^[a-zA-Z0-9_\-.:]+$/.test(name)) return 'Queue name contains invalid characters';
  return null;
}

export { validateGroupId } from '../../../domain/types/group';

// Job option bounds live in the domain so TCP, HTTP, flows, embedded adds and cron
// templates share one validator and one set of messages (src/domain/job/options.ts).
export {
  validateBackoffField,
  validateDelayArgument,
  validateJobOptions,
  validateLockDuration,
  validateNumericField,
  validatePullTimeout,
} from '../../../domain/job/options';

// Job data and setter arguments share the engine's rules (src/domain/job/mutations.ts).
export {
  validateJobData,
  validateKeepLogs,
  validatePriorityChange,
  validateUpdatedJobData,
} from '../../../domain/job/mutations';
