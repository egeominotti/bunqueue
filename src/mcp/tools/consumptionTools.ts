/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * MCP Tools - Job Consumption (Pull/Ack/Fail cycle)
 * Heartbeat, lock management. A pull with an `owner` locks each job and returns its
 * token; ack, fail and heartbeat of a locked job must then carry that token.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from '../adapter';
import type { PullLockOptions } from '../types/adapter';
import { lockOwnerField, lockTokenField, lockTtlField, queueField } from './schemas';
import { withErrorHandler } from './withErrorHandler';

const TOKEN_FOR_LOCKED_JOB =
  'Lock token returned by bunqueue_pull_job / bunqueue_pull_job_batch with an owner; required for a locked job';

/** The lock to request, or undefined for a plain pull; lockTtl alone is a mistake. */
function lockOptions(owner?: string, lockTtl?: number): PullLockOptions | undefined {
  if (owner === undefined) {
    if (lockTtl !== undefined) throw new Error('lockTtl requires owner');
    return undefined;
  }
  return lockTtl === undefined ? { owner } : { owner, lockTtl };
}

/** `tokens` must line up with `jobIds`, one entry each. */
function assertAligned(jobIds: string[], tokens: string[] | undefined): void {
  if (tokens !== undefined && tokens.length !== jobIds.length) {
    throw new Error('tokens must have exactly one entry per jobId');
  }
}

function tokensField() {
  return z
    .array(z.string())
    .optional()
    .describe(
      'Lock tokens aligned with jobIds (same length and order); use "" for a job pulled without an owner'
    );
}

function timeoutMsField() {
  return z.number().min(0).max(30000).optional().describe('Long-poll timeout in ms (0 = no wait)');
}

export function registerConsumptionTools(server: McpServer, backend: McpBackend) {
  server.tool(
    'bunqueue_pull_job',
    'Pull a single job from a queue for processing (it becomes active). Returns null if no jobs available. With owner, the job is locked and carries a token field: ack, fail and heartbeat must pass it, and a lock not renewed within lockTtl (bunqueue_job_heartbeat with the token, or bunqueue_extend_lock) expires: the job counts an attempt and is requeued (or moved to the DLQ when none remain). Without owner no lock is taken and no token is returned.',
    {
      queue: queueField(),
      timeoutMs: timeoutMsField(),
      owner: lockOwnerField().optional(),
      lockTtl: lockTtlField().optional(),
    },
    withErrorHandler('bunqueue_pull_job', async ({ queue, timeoutMs, owner, lockTtl }) => {
      const job = await backend.pullJob(queue, timeoutMs, lockOptions(owner, lockTtl));
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(job ? { job } : { job: null }, null, 2) },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_pull_job_batch',
    'Pull multiple jobs from a queue in one operation. With owner, every job is locked and carries its own token (see bunqueue_pull_job).',
    {
      queue: queueField(),
      count: z.number().min(1).max(1000).describe('Number of jobs to pull'),
      timeoutMs: timeoutMsField(),
      owner: lockOwnerField().optional(),
      lockTtl: lockTtlField().optional(),
    },
    withErrorHandler(
      'bunqueue_pull_job_batch',
      async ({ queue, count, timeoutMs, owner, lockTtl }) => {
        const lock = lockOptions(owner, lockTtl);
        const jobs = await backend.pullJobBatch(queue, count, timeoutMs, lock);
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ count: jobs.length, jobs }, null, 2) },
          ],
        };
      }
    )
  );

  server.tool(
    'bunqueue_ack_job',
    'Acknowledge an active job as completed with an optional result. A locked job (pulled with an owner) needs its token; a missing or wrong token is an error and the job stays active.',
    {
      jobId: z.string().describe('Job ID to acknowledge'),
      result: z.unknown().optional().describe('Optional result data'),
      token: lockTokenField(TOKEN_FOR_LOCKED_JOB).optional(),
    },
    withErrorHandler('bunqueue_ack_job', async ({ jobId, result, token }) => {
      await backend.ackJob(jobId, result, token);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, jobId }) }],
      };
    })
  );

  server.tool(
    'bunqueue_ack_job_batch',
    'Acknowledge multiple active jobs as completed in one operation. Locked jobs need their tokens; if any token is missing or wrong, nothing is acknowledged.',
    {
      jobIds: z.array(z.string()).min(1).describe('Array of job IDs to acknowledge'),
      tokens: tokensField(),
    },
    withErrorHandler('bunqueue_ack_job_batch', async ({ jobIds, tokens }) => {
      assertAligned(jobIds, tokens);
      await backend.ackJobBatch(jobIds, tokens);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ success: true, count: jobIds.length }) },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_fail_job',
    'Mark an active job as failed with an optional error message. It is retried after its backoff while attempts remain, otherwise it moves to the DLQ (or is deleted with removeOnFail). A locked job needs its token.',
    {
      jobId: z.string().describe('Job ID to fail'),
      error: z.string().optional().describe('Error message'),
      token: lockTokenField(TOKEN_FOR_LOCKED_JOB).optional(),
      unrecoverable: z
        .boolean()
        .optional()
        .describe('Skip the remaining attempts: the job goes straight to the DLQ (default: false)'),
    },
    withErrorHandler('bunqueue_fail_job', async ({ jobId, error, token, unrecoverable }) => {
      await backend.failJob(jobId, error, { token, unrecoverable });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, jobId }) }],
      };
    })
  );

  server.tool(
    'bunqueue_job_heartbeat',
    'Send a heartbeat for an active job to prevent stall detection. For a locked job pass its token: that also renews the lock for its lockTtl (without the token the lock is not renewed). success is false when the job is not active or the token is wrong or expired.',
    {
      jobId: z.string().describe('Job ID'),
      token: lockTokenField('Lock token of a job pulled with an owner; renews its lock').optional(),
    },
    withErrorHandler('bunqueue_job_heartbeat', async ({ jobId, token }) => {
      const success = await backend.jobHeartbeat(jobId, token);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId }) }] };
    })
  );

  server.tool(
    'bunqueue_job_heartbeat_batch',
    'Send heartbeats for multiple active jobs at once; with tokens, locked jobs also get their locks renewed. Returns how many heartbeats were accepted.',
    {
      jobIds: z.array(z.string()).min(1).describe('Array of job IDs'),
      tokens: tokensField(),
    },
    withErrorHandler('bunqueue_job_heartbeat_batch', async ({ jobIds, tokens }) => {
      assertAligned(jobIds, tokens);
      const count = await backend.jobHeartbeatBatch(jobIds, tokens);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ success: true, acknowledged: count }) },
        ],
      };
    })
  );

  server.tool(
    'bunqueue_extend_lock',
    'Extend the lock on a locked active job so it is not reclaimed: the lock then expires duration ms from now. success is false when the token is wrong or the lock has already expired.',
    {
      jobId: z.string().describe('Job ID'),
      token: lockTokenField(
        'Lock token returned by bunqueue_pull_job / bunqueue_pull_job_batch with an owner'
      ),
      duration: lockTtlField('New lock lifetime from now, in ms (1000 to 86,400,000)'),
    },
    withErrorHandler('bunqueue_extend_lock', async ({ jobId, token, duration }) => {
      const success = await backend.extendLock(jobId, token, duration);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success, jobId }) }] };
    })
  );
}
