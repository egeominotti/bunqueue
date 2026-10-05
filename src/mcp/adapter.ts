/** MCP backend selection and public adapter API. */

import { EmbeddedBackend } from './backend/embedded';
import { TcpBackend } from './backend/tcp';
import { brokerConnectionFromEnv } from './backend/tcp/env';
import type { McpBackend } from './types/adapter';

export { EmbeddedBackend } from './backend/embedded';
export { TcpBackend } from './backend/tcp';
export type {
  FlowJobInput,
  FlowNodeResult,
  FlowStepInput,
  JobCounts,
  McpBackend,
  PulledJob,
  SerializedCron,
  SerializedJob,
  WebhookInfo,
  WorkerInfo,
} from './types/adapter';
export type {
  DlqQuery,
  QueueLimits,
  SerializedDlqAttempt,
  SerializedDlqEntry,
  SerializedDlqStats,
} from './types/inspection';
export type {
  FailJobOptions,
  McpBackoff,
  McpBulkJob,
  McpDeduplication,
  McpFlowJobOptions,
  McpJobOptions,
  PullLockOptions,
  SerializedJobOptions,
} from './types/jobOptions';

export async function createBackend(): Promise<McpBackend> {
  if ((process.env.BUNQUEUE_MODE ?? 'embedded') === 'tcp') {
    // Throws on an invalid BUNQUEUE_PORT / BUNQUEUE_POOL_SIZE: startup stops, naming it.
    const backend = new TcpBackend(brokerConnectionFromEnv());
    await backend.connect();
    return backend;
  }
  return new EmbeddedBackend();
}
