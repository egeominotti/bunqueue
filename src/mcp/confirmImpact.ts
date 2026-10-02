/**
 * Human-readable impact of a guarded MCP call, shown before it is confirmed.
 * Best effort: a lookup failure falls back to a generic description and never
 * blocks the confirmation flow itself.
 */

import type { McpBackend } from './adapter';
import type { JobCounts } from './types/adapter';
import { describeSignalImpact } from './workflow/signal';
import type { WorkflowDb } from './workflow/workflowDb';

/** Sources beyond the queue backend that an impact description can read. */
export interface ImpactContext {
  /** The workflow store, when the workflow tools are enabled (BUNQUEUE_MCP_WORKFLOW_DB). */
  workflows?: WorkflowDb;
}

/** Ready jobs of a paused queue are counted under `paused`, not waiting/prioritized. */
const pausedText = (c: JobCounts) => (c.paused ? `, ${c.paused} paused` : '');

function countsText(c: JobCounts): string {
  const children = c['waiting-children'] ? `, ${c['waiting-children']} waiting for children` : '';
  return `${c.waiting} waiting, ${c.prioritized} prioritized, ${c.delayed} delayed${pausedText(c)}${children}, ${c.active} active, ${c.completed} completed, ${c.failed} failed`;
}

async function jobText(backend: McpBackend, jobId: string): Promise<string> {
  const job = await backend.getJob(jobId);
  return job
    ? `job ${jobId} ("${job.name}", ${job.state}, queue "${job.queue}")`
    : `job ${jobId} (not found)`;
}

async function describe(
  name: string,
  args: Record<string, unknown>,
  backend: McpBackend,
  context: ImpactContext
): Promise<string | null> {
  const queue = String(args.queue ?? '');
  switch (name) {
    case 'bunqueue_obliterate_queue': {
      const c = await backend.getJobCounts(queue);
      return `Permanently delete queue "${queue}" and every job in it (${countsText(c)}), including results and logs.`;
    }
    case 'bunqueue_drain_queue': {
      const c = await backend.getJobCounts(queue);
      return `Remove every job still waiting to run in queue "${queue}" (${c.waiting} waiting, ${c.prioritized} prioritized, ${c.delayed} delayed${pausedText(c)}); active jobs keep running.`;
    }
    case 'bunqueue_clean_queue': {
      const state = typeof args.state === 'string' ? args.state : 'completed and failed';
      const limit = typeof args.limit === 'number' ? ` (at most ${args.limit})` : '';
      return `Permanently remove ${state} jobs older than ${Number(args.graceMs)} ms from queue "${queue}"${limit}.`;
    }
    case 'bunqueue_purge_dlq': {
      const { total } = await backend.getDlqStats(queue);
      return `Permanently delete ${total} dead letter entries of queue "${queue}"; they can no longer be inspected or retried.`;
    }
    case 'bunqueue_retry_completed': {
      const c = await backend.getJobCounts(queue);
      return `Re-run all ${c.completed} completed jobs of queue "${queue}"; whatever they do (emails, payments, API calls) happens again.`;
    }
    case 'bunqueue_cancel_job':
      return `Permanently remove ${await jobText(backend, String(args.jobId ?? ''))}.`;
    case 'bunqueue_clear_job_logs': {
      const keep = typeof args.keepLogs === 'number' ? `, keeping the last ${args.keepLogs}` : '';
      return `Delete the log entries of ${await jobText(backend, String(args.jobId ?? ''))}${keep}.`;
    }
    case 'bunqueue_delete_cron': {
      const cron = await backend.getCron(String(args.name ?? ''));
      const when = cron
        ? ` (${cron.schedule ?? `every ${cron.repeatEvery} ms`}, queue "${cron.queue}")`
        : ' (not found)';
      return `Delete the recurring schedule "${String(args.name ?? '')}"${when}; it will not fire again.`;
    }
    case 'bunqueue_remove_webhook': {
      const id = String(args.id ?? '');
      const hook = (await backend.listWebhooks()).find((w) => w.id === id);
      return `Remove webhook ${id}${hook ? ` (${hook.url})` : ' (not found)'}; it will stop receiving job events.`;
    }
    case 'bunqueue_signal_workflow':
      return context.workflows ? describeSignalImpact(context.workflows, args) : null;
    default:
      return null;
  }
}

export async function describeImpact(
  name: string,
  args: Record<string, unknown>,
  backend: McpBackend,
  context: ImpactContext = {}
): Promise<string> {
  try {
    const text = await describe(name, args, backend, context);
    if (text) return text;
  } catch {
    // Fall through to the generic description.
  }
  return `Run ${name.replace(/^bunqueue_/, '')} with ${JSON.stringify(args)}.`;
}
