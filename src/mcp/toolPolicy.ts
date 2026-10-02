/**
 * MCP tool policy: which toolset each tool belongs to, its MCP annotations, and
 * whether it needs an explicit confirmation when BUNQUEUE_MCP_CONFIRM is enabled.
 *
 * Every registered tool must have exactly one entry here (enforced at startup and
 * by test/mcp-tool-policy.test.ts), so a new tool cannot ship unclassified.
 */

export const TOOLSETS = {
  jobs: 'Create jobs and read single jobs: add one or many jobs, look a job up by id or custom id, read its state, result, progress, logs; wait for a job to finish; write progress or log lines.',
  'job-control':
    'Change an existing job before or instead of it running: cancel, discard, promote a delayed job to run now, change priority, delay or reschedule, edit its payload.',
  processing:
    'Consume jobs manually as a worker: pull/take jobs, acknowledge completion, mark failure, send job heartbeats, extend job locks.',
  queues:
    "Whole-queue operations: list queues, count and list a queue's jobs in any state (waiting, delayed, active, completed, failed), counts per priority, pause/resume and check paused, drain queued jobs, clean old jobs, obliterate a queue.",
  dlq: 'Dead letter queue: inspect permanently failed jobs with their failure reason, error and attempt history, filter them by reason, count them per reason; retry them, purge them; re-run already completed jobs.',
  cron: 'Recurring schedules: add a cron pattern (in any time zone) or fixed interval job with its job name, options, run limit and overlap/no-worker policies; list schedules and next runs, read or delete one.',
  limits:
    'Throughput controls on a queue: set or clear a rate limit (max jobs started per time window, default per second) and a concurrency limit (max simultaneous active jobs); read the current limits, active count and whether they are holding jobs back.',
  flows:
    "Job dependencies: parent/child trees, sequential chains, fan-out then fan-in, read a flow tree or the children's return values.",
  workers:
    'Who processes jobs: register, list, heartbeat and unregister workers; register/list/remove HTTP handlers that auto-process a queue by calling an HTTP endpoint.',
  webhooks:
    'Outgoing notifications: add, list, enable/disable or remove webhooks called on job events.',
  monitoring:
    'Server and queue health: overall stats, per-queue stats, memory and storage status, Prometheus metrics, memory compaction.',
  workflows:
    'Workflow engine runs (only when the MCP server is started with BUNQUEUE_MCP_WORKFLOW_DB): list and inspect executions, their steps and signals; deliver a human-in-the-loop signal such as an approval to a run parked at waitFor.',
} as const;

export type ToolsetId = keyof typeof TOOLSETS;
export const TOOLSET_IDS = Object.keys(TOOLSETS) as ToolsetId[];

/** Argument that names what a confirmed destructive call acts on. */
export type ConfirmTarget = 'queue' | 'jobId' | 'name' | 'id' | 'executionId';

export interface ToolPolicy {
  toolset: ToolsetId;
  readOnly: boolean;
  /** Deletes or irreversibly overwrites data (MCP destructiveHint). */
  destructive: boolean;
  idempotent: boolean;
  /** Reaches systems outside bunqueue, such as HTTP endpoints (MCP openWorldHint). */
  openWorld: boolean;
  /**
   * Irreversible data loss, re-running already completed work in bulk, or an irrevocable
   * approval: requires confirmation when enabled. Retrying failed jobs from the DLQ is the
   * normal remedy for a failure and is not guarded.
   */
  confirm?: { target: ConfirmTarget; when?: (args: Record<string, unknown>) => boolean };
  /**
   * Registered only under an opt-in setting (the workflow tools need
   * BUNQUEUE_MCP_WORKFLOW_DB), so the coverage check tolerates its absence.
   */
  optional?: boolean;
}

const read = (toolset: ToolsetId): ToolPolicy => ({
  toolset,
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
});
const write = (
  toolset: ToolsetId,
  idempotent: boolean,
  extra: Partial<ToolPolicy> = {}
): ToolPolicy => ({
  toolset,
  readOnly: false,
  destructive: false,
  idempotent,
  openWorld: false,
  ...extra,
});
const destroy = (toolset: ToolsetId, idempotent: boolean, target: ConfirmTarget): ToolPolicy =>
  write(toolset, idempotent, { destructive: true, confirm: { target } });
const optional = (policy: ToolPolicy): ToolPolicy => ({ ...policy, optional: true });

export const TOOL_POLICIES: Record<string, ToolPolicy> = {
  // jobs
  bunqueue_add_job: write('jobs', false),
  bunqueue_add_jobs_bulk: write('jobs', false),
  bunqueue_get_job: read('jobs'),
  bunqueue_get_job_state: read('jobs'),
  bunqueue_get_job_result: read('jobs'),
  bunqueue_get_job_by_custom_id: read('jobs'),
  bunqueue_wait_for_job: read('jobs'),
  bunqueue_get_progress: read('jobs'),
  bunqueue_update_progress: write('jobs', true),
  bunqueue_get_job_logs: read('jobs'),
  bunqueue_add_job_log: write('jobs', false),
  bunqueue_clear_job_logs: destroy('jobs', true, 'jobId'),
  // job-control
  bunqueue_cancel_job: destroy('job-control', true, 'jobId'),
  // Discarded jobs land in the DLQ and can be retried, so discard is not guarded.
  bunqueue_discard_job: write('job-control', true),
  bunqueue_promote_job: write('job-control', true),
  bunqueue_update_job_data: write('job-control', true, { destructive: true }),
  bunqueue_change_job_priority: write('job-control', true),
  bunqueue_move_to_delayed: write('job-control', false),
  bunqueue_change_delay: write('job-control', false),
  // processing
  bunqueue_pull_job: write('processing', false),
  bunqueue_pull_job_batch: write('processing', false),
  bunqueue_ack_job: write('processing', false),
  bunqueue_ack_job_batch: write('processing', false),
  bunqueue_fail_job: write('processing', false),
  bunqueue_job_heartbeat: write('processing', true),
  bunqueue_job_heartbeat_batch: write('processing', true),
  bunqueue_extend_lock: write('processing', false),
  // queues
  bunqueue_list_queues: read('queues'),
  bunqueue_count_jobs: read('queues'),
  bunqueue_get_jobs: read('queues'),
  bunqueue_get_job_counts: read('queues'),
  bunqueue_get_counts_per_priority: read('queues'),
  bunqueue_is_paused: read('queues'),
  bunqueue_pause_queue: write('queues', true),
  bunqueue_resume_queue: write('queues', true),
  bunqueue_drain_queue: destroy('queues', true, 'queue'),
  bunqueue_clean_queue: destroy('queues', false, 'queue'),
  bunqueue_obliterate_queue: destroy('queues', true, 'queue'),
  // dlq
  bunqueue_get_dlq: read('dlq'),
  bunqueue_get_dlq_stats: read('dlq'),
  bunqueue_retry_dlq: write('dlq', false),
  bunqueue_purge_dlq: destroy('dlq', true, 'queue'),
  bunqueue_retry_completed: write('dlq', false, {
    // Re-running every completed job repeats its side effects; one job is a normal retry.
    confirm: { target: 'queue', when: (args) => args.jobId === undefined },
  }),
  // cron
  bunqueue_add_cron: write('cron', true),
  bunqueue_list_crons: read('cron'),
  bunqueue_get_cron: read('cron'),
  bunqueue_delete_cron: destroy('cron', true, 'name'),
  // limits
  bunqueue_set_rate_limit: write('limits', true),
  bunqueue_clear_rate_limit: write('limits', true),
  bunqueue_set_concurrency: write('limits', true),
  bunqueue_clear_concurrency: write('limits', true),
  bunqueue_get_queue_limits: read('limits'),
  // flows
  bunqueue_add_flow: write('flows', false),
  bunqueue_add_flow_chain: write('flows', false),
  bunqueue_add_flow_bulk_then: write('flows', false),
  bunqueue_get_flow: read('flows'),
  bunqueue_get_children_values: read('flows'),
  // workers
  bunqueue_register_worker: write('workers', false),
  bunqueue_unregister_worker: write('workers', true),
  bunqueue_worker_heartbeat: write('workers', true),
  bunqueue_list_workers: read('workers'),
  bunqueue_register_handler: write('workers', false, { openWorld: true }),
  bunqueue_unregister_handler: write('workers', true),
  bunqueue_list_handlers: read('workers'),
  // webhooks
  bunqueue_add_webhook: write('webhooks', false, { openWorld: true }),
  bunqueue_remove_webhook: destroy('webhooks', true, 'id'),
  bunqueue_list_webhooks: read('webhooks'),
  bunqueue_set_webhook_enabled: write('webhooks', true),
  // monitoring
  bunqueue_get_stats: read('monitoring'),
  bunqueue_get_queue_stats: read('monitoring'),
  bunqueue_get_per_queue_stats: read('monitoring'),
  bunqueue_get_memory_stats: read('monitoring'),
  bunqueue_get_storage_status: read('monitoring'),
  bunqueue_get_prometheus_metrics: read('monitoring'),
  bunqueue_compact_memory: write('monitoring', true),
  // workflows (registered only with BUNQUEUE_MCP_WORKFLOW_DB)
  bunqueue_list_workflow_executions: optional(read('workflows')),
  bunqueue_get_workflow_execution: optional(read('workflows')),
  // A signal is an approval: the first one wins and can never be withdrawn.
  bunqueue_signal_workflow: optional(
    write('workflows', false, { confirm: { target: 'executionId' } })
  ),
};

/** MCP annotations derived from a policy; destructive/idempotent only mean something for writes. */
export function annotationsFor(policy: ToolPolicy) {
  return {
    readOnlyHint: policy.readOnly,
    destructiveHint: !policy.readOnly && policy.destructive,
    idempotentHint: policy.idempotent,
    openWorldHint: policy.openWorld,
  };
}
