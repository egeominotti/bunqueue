/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Prompts
 * Pre-built prompt templates for AI agents: health reports, queue debugging, incident response.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from './adapter';
import { totalJobs } from './diagnostics';
import { boundedPrompt, boundedRows, boundedValue } from './inspectionBounds';
import { listJobsPage } from './inspectionPage';
import { errorPrompt } from './promptHelpers';

/** Max queues to include in health report to avoid oversized prompts */
const MAX_QUEUES_IN_REPORT = 50;

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
            limits: await backend.getQueueLimits(q),
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
                text: boundedPrompt(`Analyze the following bunqueue server health data and produce a structured health report.

For each area, assign a severity level: OK, WARNING, or CRITICAL.

## System Stats
${JSON.stringify(stats, null, 2)}

## Storage Status
${JSON.stringify(storage, null, 2)}

## Queue Details (${queueDetails.length}${truncated ? ` of ${queues.length}` : ''} queues)
${JSON.stringify(
  boundedRows(queueDetails, (q) => ({ ...q, total: totalJobs(q.counts) })),
  null,
  2
)}

## Workers (${workers.length} registered)
${JSON.stringify(boundedRows(workers), null, 2)}

## Cron Jobs (${crons.length} scheduled)
${JSON.stringify(boundedRows(crons), null, 2)}

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
7. **Recommendations** — Prioritized list of actions to take`),
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
        const [counts, paused, dlqStats, dlqPage, activePage, priorities, limits] =
          await Promise.all([
            backend.getJobCounts(queue),
            backend.isPaused(queue),
            backend.getDlqStats(queue),
            backend.getDlqEntries(queue, { limit: 10 }),
            listJobsPage(backend, { queue, state: 'active', limit: 10 }),
            backend.getCountsPerPriority(queue),
            backend.getQueueLimits(queue),
          ]);

        const total = totalJobs(counts);

        return {
          description: `Deep diagnostic for queue "${queue}"`,
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: boundedPrompt(`Analyze the following diagnostic data for bunqueue queue "${queue}" and identify any issues.

## Job State Breakdown
${JSON.stringify(counts, null, 2)}

## Queue Status
- Paused: ${paused}
- Total jobs: ${total}

## Queue Limits
${JSON.stringify(limits, null, 2)}

## Active Jobs (${counts.active} currently processing, showing ${activePage.count})
${JSON.stringify(activePage, null, 2)}

## Dead Letter Queue (${dlqStats.total} entries, showing the oldest ${dlqPage.entries.length})
Entries by failure reason: ${JSON.stringify(dlqStats.byReason)}
${JSON.stringify(
  boundedRows(dlqPage.entries, (entry) => ({
    jobId: entry.job.id,
    reason: entry.reason,
    enteredAt: entry.enteredAt,
    attemptCount: entry.attemptCount,
  })),
  null,
  2
)}

## Priority Distribution
${JSON.stringify(boundedValue(priorities).value, null, 2)}

---

Analyze and report:
1. **Queue Health** — Overall assessment (HEALTHY, DEGRADED, or UNHEALTHY)
2. **Backlog Analysis** — Describe ready/delayed/dependency counts; growth requires observations over time
3. **Failure Analysis** — Failed count and DLQ reasons; inspect error messages with bunqueue_get_dlq before identifying message patterns
4. **Stuck Jobs** — Active age alone cannot establish a stall; inspect heartbeat/lease evidence
5. **Priority Issues** — A snapshot cannot establish priority starvation
6. **Recommendations** — Specific actions to resolve identified issues`),
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
        const totalQueues = queue ? 1 : allQueues.length;
        const queueDiagnostics = await Promise.all(
          targetQueues.map(async (q) => {
            const [counts, paused, dlq, limits] = await Promise.all([
              backend.getJobCounts(q),
              backend.isPaused(q),
              backend.getDlqStats(q),
              backend.getQueueLimits(q),
            ]);
            const dlqByReason = Object.fromEntries(
              Object.entries(dlq.byReason).filter(([, count]) => count > 0)
            );
            return {
              name: q,
              counts,
              total: totalJobs(counts),
              paused,
              limits,
              dlqEntries: dlq.total,
              dlqByReason,
            };
          })
        );

        const problematic = queueDiagnostics.filter(
          (q) =>
            q.paused ||
            q.limits.rateLimited ||
            q.limits.concurrencyMaxed ||
            q.dlqEntries > 0 ||
            (q.counts.waiting + q.counts.prioritized > 0 && q.counts.active === 0)
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
                text: boundedPrompt(`INCIDENT: Jobs are not being processed. Triage and resolve.

Queue scope: ${targetQueues.length} of ${totalQueues}; truncated: ${targetQueues.length < totalQueues}.

## System Overview
${JSON.stringify(stats, null, 2)}

## Workers (${workers.length} registered)
${JSON.stringify(boundedRows(workers), null, 2)}

## Queue Diagnostics (${queueDiagnostics.length} of ${totalQueues} queues)
${JSON.stringify(boundedRows(queueDiagnostics, undefined, totalQueues), null, 2)}

## Flagged Queues (${problematic.length} problematic)
${JSON.stringify(boundedRows(problematic), null, 2)}

---

Run through this checklist:

### Step 1: Worker Health
- Are workers registered? Registration is optional; zero registered workers does not prove no consumers
- Are heartbeats fresh? (stale if lastHeartbeat > 60s ago)
- Are workers assigned to the affected queues?

### Step 2: Queue Status
- Which queues are paused? (Use \`bunqueue_resume_queue\` to unpause)
- Which have ready jobs and no active jobs? Check limits and consumers; this alone does not establish a stall
- Are rate limits, concurrency limits, delays or dependencies holding jobs back?

### Step 3: Throughput
- Is throughput zero or abnormally low?
- Compare push rate vs pull rate

### Step 4: DLQ Analysis
- Which queues have DLQ entries?
- Are jobs failing repeatedly? (Use \`bunqueue_get_dlq\` for the errors, filtered by reason if useful)

### Step 5: Root Cause & Resolution
Identify hypotheses supported by the observations and propose specific actions using bunqueue tools. Unknown causes must remain unknown.`),
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
