/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Prompts
 * Pre-built prompt templates for AI agents: health reports, queue debugging, incident response.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from './adapter';

/** Max queues to include in health report to avoid oversized prompts */
const MAX_QUEUES_IN_REPORT = 50;

function errorPrompt(description: string, error: string) {
  return {
    description,
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Failed to gather bunqueue data: ${error}\n\nThe server may be unreachable. Check connectivity and try again.`,
        },
      },
    ],
  };
}

export function registerPrompts(server: McpServer, backend: McpBackend) {
  // ─── Health Report ─────────────────────────────────────────────────────

  server.prompt(
    'bunqueue_health_report',
    'Generate a comprehensive health report for the bunqueue server with severity levels (OK/WARNING/CRITICAL).',
    async () => {
      try {
        const [stats, storage, queues, workers, crons, memory] = await Promise.all([
          backend.getStats(),
          backend.getStorageStatus(),
          backend.listQueues(),
          backend.listWorkers(),
          backend.listCrons(),
          backend.getMemoryStats(),
        ]);

        const limitedQueues = queues.slice(0, MAX_QUEUES_IN_REPORT);
        const queueDetails = await Promise.all(
          limitedQueues.map(async (q) => ({
            name: q,
            counts: await backend.getJobCounts(q),
            paused: await backend.isPaused(q),
          }))
        );

        const truncated = queues.length > MAX_QUEUES_IN_REPORT;

        return {
          description: 'Comprehensive bunqueue server health report',
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: `Analyze the following bunqueue server health data and produce a structured health report.

For each area, assign a severity level: OK, WARNING, or CRITICAL.

## System Stats
${JSON.stringify(stats, null, 2)}

## Storage Status
${JSON.stringify(storage, null, 2)}

## Queue Details (${queueDetails.length}${truncated ? ` of ${queues.length}` : ''} queues)
${JSON.stringify(queueDetails, null, 2)}

## Workers (${workers.length} registered)
${JSON.stringify(workers, null, 2)}

## Cron Jobs (${crons.length} scheduled)
${JSON.stringify(crons, null, 2)}

## Memory Stats
${JSON.stringify(memory, null, 2)}

---

Produce a report with these sections:
1. **Overall Health** — One-line summary with overall severity
2. **Storage** — Disk health (CRITICAL if diskFull or error present)
3. **Queues** — Per-queue assessment: flag if failed > 10% of total, flag if paused
4. **Workers** — Worker count and heartbeat freshness (stale if >60s ago)
5. **Memory** — Collections near capacity limits
6. **Cron Jobs** — Scheduled job status, any missed next_run times
7. **Recommendations** — Prioritized list of actions to take`,
              },
            },
          ],
        };
      } catch (err: unknown) {
        return errorPrompt(
          'Error gathering health data',
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  );

  // ─── Debug Queue ───────────────────────────────────────────────────────

  server.prompt(
    'bunqueue_debug_queue',
    'Deep diagnostic of a specific queue: job counts, pause status, DLQ entries, active jobs, and priority distribution.',
    { queue: z.string().describe('Queue name to debug') },
    async ({ queue }) => {
      try {
        const [counts, paused, dlqStats, dlqPage, activeJobs, priorities] = await Promise.all([
          backend.getJobCounts(queue),
          backend.isPaused(queue),
          backend.getDlqStats(queue),
          backend.getDlqEntries(queue, { limit: 10 }),
          backend.getJobs(queue, { state: 'active' }),
          backend.getCountsPerPriority(queue),
        ]);

        const total =
          counts.waiting + counts.delayed + counts.active + counts.completed + counts.failed;

        return {
          description: `Deep diagnostic for queue "${queue}"`,
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: `Analyze the following diagnostic data for bunqueue queue "${queue}" and identify any issues.

## Job State Breakdown
${JSON.stringify(counts, null, 2)}

## Queue Status
- Paused: ${paused}
- Total jobs: ${total}

## Active Jobs (${activeJobs.length} currently processing)
${JSON.stringify(activeJobs, null, 2)}

## Dead Letter Queue (${dlqStats.total} entries, showing the oldest ${dlqPage.entries.length})
Entries by failure reason: ${JSON.stringify(dlqStats.byReason)}
${JSON.stringify(dlqPage.entries, null, 2)}

## Priority Distribution
${JSON.stringify(priorities, null, 2)}

---

Analyze and report:
1. **Queue Health** — Overall assessment (HEALTHY, DEGRADED, or UNHEALTHY)
2. **Backlog Analysis** — Waiting-to-active ratio, is the queue growing?
3. **Failure Analysis** — Failed count, DLQ reasons and error messages, common patterns
4. **Stuck Jobs** — Active jobs that may be stalled (check startedAt timestamps)
5. **Priority Issues** — Priority starvation (low-priority jobs not processed)
6. **Recommendations** — Specific actions to resolve identified issues`,
              },
            },
          ],
        };
      } catch (err: unknown) {
        return errorPrompt(
          `Error debugging queue "${queue}"`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  );

  // ─── Incident Response ─────────────────────────────────────────────────

  server.prompt(
    'bunqueue_incident_response',
    'Incident response playbook: identifies backed-up queues, checks worker health, provides step-by-step triage for "jobs not processing".',
    { queue: z.string().optional().describe('Specific queue to investigate (omit to check all)') },
    async ({ queue }) => {
      try {
        const [allQueues, workers, stats] = await Promise.all([
          backend.listQueues(),
          backend.listWorkers(),
          backend.getStats(),
        ]);

        const targetQueues = queue ? [queue] : allQueues.slice(0, MAX_QUEUES_IN_REPORT);
        const queueDiagnostics = await Promise.all(
          targetQueues.map(async (q) => {
            const [counts, paused, dlq] = await Promise.all([
              backend.getJobCounts(q),
              backend.isPaused(q),
              backend.getDlqStats(q),
            ]);
            const dlqByReason = Object.fromEntries(
              Object.entries(dlq.byReason).filter(([, count]) => count > 0)
            );
            return { name: q, counts, paused, dlqEntries: dlq.total, dlqByReason };
          })
        );

        const problematic = queueDiagnostics.filter(
          (q) => q.paused || q.dlqEntries > 0 || (q.counts.waiting > 0 && q.counts.active === 0)
        );

        return {
          description: queue
            ? `Incident response for queue "${queue}"`
            : 'Incident response: jobs not processing',
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: `INCIDENT: Jobs are not being processed. Triage and resolve.

## System Overview
${JSON.stringify(stats, null, 2)}

## Workers (${workers.length} registered)
${JSON.stringify(workers, null, 2)}

## Queue Diagnostics (${queueDiagnostics.length} queues)
${JSON.stringify(queueDiagnostics, null, 2)}

## Flagged Queues (${problematic.length} problematic)
${JSON.stringify(problematic, null, 2)}

---

Run through this checklist:

### Step 1: Worker Health
- Are workers registered? (0 workers = root cause)
- Are heartbeats fresh? (stale if lastHeartbeat > 60s ago)
- Are workers assigned to the affected queues?

### Step 2: Queue Status
- Which queues are paused? (Use \`bunqueue_resume_queue\` to unpause)
- Which have waiting > 0 but active = 0? (These are stuck)

### Step 3: Throughput
- Is throughput zero or abnormally low?
- Compare push rate vs pull rate

### Step 4: DLQ Analysis
- Which queues have DLQ entries?
- Are jobs failing repeatedly? (Use \`bunqueue_get_dlq\` for the errors, filtered by reason if useful)

### Step 5: Root Cause & Resolution
Identify the most likely root cause and provide specific actions using bunqueue tools.`,
              },
            },
          ],
        };
      } catch (err: unknown) {
        return errorPrompt(
          'Error gathering incident data',
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  );
}
