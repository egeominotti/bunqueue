/**
 * Repro: duration arguments of job commands are not validated.
 *
 * ChangeDelay and MoveToDelayed computed `runAt = now + delay` from any value, so a
 * NaN (or missing) delay produced a job that never became ready, and pull waiters
 * then re-polled every ~1 ms. PULL/PULLB `lockTtl`, ExtendLock(s) `duration(s)` and
 * JobHeartbeat `duration` computed `expiresAt = now + ttl`: NaN or Infinity gave a
 * lease that never expires. Cron templates copied `jobOptions` raw, so a TCP client
 * could bypass every PUSH rule through `Cron`, and `repeatEvery` had no upper bound (a
 * value above 8.64e15 is not a valid date).
 *
 * The TCP/HTTP handlers must reply with a protocol error, and embedded mode must
 * throw the same message. Finite values 2.9.10 applied (a negative delay, a lease of
 * 0, a timeout above a day) keep their 2.9.10 result: repro-compat-job-wire.test.ts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { jobId } from '../src/domain/types/job';
import type { Command } from '../src/domain/types/command';
import { handleCommand } from '../src/infrastructure/server/handler';
import { routeQueueJobOperations } from '../src/infrastructure/server/http-routes/queueJobs';
import type { HandlerContext } from '../src/infrastructure/server/types';

/** The honoured job duration (MAX_JOB_DURATION_MS): a longer cron interval is refused. */
const MAX_DURATION = 4_320_000_000_000_000;

let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
});

function context(qm: QueueManager): HandlerContext {
  return { queueManager: qm, authTokens: new Set<string>(), authenticated: false };
}

async function send(command: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const qm = manager as QueueManager;
  return (await handleCommand(command as unknown as Command, context(qm))) as {
    ok: boolean;
    error?: string;
  };
}

async function errorOf(command: Record<string, unknown>): Promise<string> {
  const response = await send(command);
  return response.ok ? '<accepted>' : String(response.error);
}

async function leasedJob(queue: string): Promise<{ id: string; token: string }> {
  await send({ cmd: 'PUSH', queue, name: 'task', data: {} });
  const pulled = (await send({ cmd: 'PULL', queue, owner: 'w1' })) as unknown as {
    job: { id: string };
    token: string;
  };
  return { id: pulled.job.id, token: pulled.token };
}

describe('TCP job commands validate their durations', () => {
  test('ChangeDelay and MoveToDelayed reject a missing, non-finite or out-of-range delay', async () => {
    manager = new QueueManager();
    await send({ cmd: 'PUSH', queue: 'cmd-delay', name: 'task', data: {}, delay: 60_000 });
    const [job] = manager.getJobs('cmd-delay', { state: ['delayed'] });
    const mismatches: string[] = [];
    for (const cmd of ['ChangeDelay', 'MoveToDelayed']) {
      for (const [delay, message] of [
        [undefined, 'delay is required'],
        [Number.NaN, 'delay must be a finite number'],
        [Infinity, 'delay must be a finite number'],
        // A negative delay (ready now) and one above a year are applied, as on 2.9.10
        // (repro-compat-job-wire.test.ts).
      ] as const) {
        const error = await errorOf({ cmd, id: job.id, delay });
        if (!error.includes(message)) mismatches.push(`${cmd} ${String(delay)}: ${error}`);
      }
    }
    expect(mismatches).toEqual([]);
    const stored = await manager.getJob(job.id);
    expect(Number.isFinite(stored?.runAt)).toBe(true);
  });

  test('PULL and PULLB reject a lockTtl that never expires before claiming a job', async () => {
    manager = new QueueManager();
    await send({ cmd: 'PUSH', queue: 'cmd-lock', name: 'task', data: {} });
    const mismatches: string[] = [];
    for (const [lockTtl, message] of [
      [Number.NaN, 'lockTtl must be a finite number'],
      [Infinity, 'lockTtl must be a finite number'],
      ['5000', 'lockTtl must be a number'],
      // Any finite lockTtl is granted, as 2.9.10 did (a 2.9.10 Worker with lockDuration 0
      // sends 0; see repro-compat-job-wire.test.ts).
    ] as const) {
      for (const cmd of [
        { cmd: 'PULL', queue: 'cmd-lock', owner: 'w1', lockTtl },
        { cmd: 'PULLB', queue: 'cmd-lock', count: 1, owner: 'w1', lockTtl },
      ]) {
        const error = await errorOf(cmd);
        if (!error.includes(message)) mismatches.push(`${cmd.cmd} ${String(lockTtl)}: ${error}`);
      }
    }
    expect(mismatches).toEqual([]);
    expect(manager.getQueueJobCounts('cmd-lock')).toMatchObject({ waiting: 1, active: 0 });
  });

  test('ExtendLock, ExtendLocks and JobHeartbeat reject a duration that never expires', async () => {
    manager = new QueueManager();
    const leased = await leasedJob('cmd-extend');
    const before = manager.getLockInfo(jobId(leased.id))?.expiresAt;
    const mismatches: string[] = [];
    for (const [duration, message] of [
      [Number.NaN, 'duration must be a finite number'],
      [Infinity, 'duration must be a finite number'],
      // Any finite duration is applied, as 2.9.10 did (repro-compat-job-wire.test.ts).
    ] as const) {
      const single = await errorOf({ cmd: 'ExtendLock', ...leased, duration });
      if (!single.includes(message)) mismatches.push(`ExtendLock ${String(duration)}: ${single}`);
      const batch = await errorOf({
        cmd: 'ExtendLocks',
        ids: [leased.id],
        tokens: [leased.token],
        durations: [duration],
      });
      if (batch !== `durations[0]: ${message}`) {
        mismatches.push(`ExtendLocks ${String(duration)}: ${batch}`);
      }
      const heartbeat = await errorOf({ cmd: 'JobHeartbeat', ...leased, duration });
      if (!heartbeat.includes(message)) {
        mismatches.push(`JobHeartbeat ${String(duration)}: ${heartbeat}`);
      }
    }
    expect(mismatches).toEqual([]);
    expect(manager.getLockInfo(jobId(leased.id))?.expiresAt).toBe(before);
  });

  test('Cron rejects template options, priority and repeatEvery that cannot run', async () => {
    manager = new QueueManager();
    const base = { cmd: 'Cron', queue: 'cmd-cron', data: {}, repeatEvery: 60_000 };
    const mismatches: string[] = [];
    let index = 0;
    for (const [fields, message] of [
      // Values 2.9.10 stored and ran (timeout/stallTimeout above a day, maxAttempts 0,
      // a delay above a year, ...) are accepted: repro-compat-job-wire.test.ts.
      [{ jobOptions: { timeout: -1 } }, 'jobOptions.timeout must be at least 0'],
      [{ jobOptions: { timeout: Number.NaN } }, 'jobOptions.timeout must be a finite number'],
      [{ jobOptions: { backoff: Number.NaN } }, 'jobOptions.backoff must be a finite number'],
      [{ jobOptions: { maxAttempts: Number.NaN } }, 'jobOptions.maxAttempts must be a number'],
      [
        { jobOptions: { stallTimeout: Infinity } },
        'jobOptions.stallTimeout must be a finite number',
      ],
      [{ priority: Number.NaN }, 'priority must be a finite number'],
      [{ dedup: { ttl: Number.NaN } }, 'dedup.ttl must be a finite number'],
      [{ repeatEvery: MAX_DURATION + 1 }, `repeatEvery must be at most ${MAX_DURATION}`],
    ] as const) {
      const name = `cron-invalid-${index++}`;
      const error = await errorOf({ ...base, name, ...fields });
      if (!error.includes(message)) mismatches.push(`${JSON.stringify(fields)}: ${error}`);
    }
    expect(mismatches).toEqual([]);
    expect(manager.listCrons()).toEqual([]);
  });

  test('HTTP push applies the shared bounds (repeat.every)', async () => {
    manager = new QueueManager();
    const body = JSON.stringify({ data: {}, repeat: { every: 0 } });
    const request = new Request('http://localhost/queues/cmd-http/jobs', { method: 'POST', body });
    const response = await routeQueueJobOperations(
      request,
      '/queues/cmd-http/jobs',
      'POST',
      context(manager),
      new Set()
    );
    expect(response?.status).toBe(400);
    expect(((await response?.json()) as { error: string }).error).toBe(
      'repeat.every must be a positive finite number'
    );
  });
});

describe('embedded job commands validate their durations like TCP', () => {
  test('changeDelay, moveToDelayed, extendLock and pullWithLock throw the TCP message', async () => {
    manager = new QueueManager();
    const waiting = await manager.push('emb-cmd', { data: {}, delay: 60_000 });
    await expect(manager.changeDelay(waiting.id, Number.NaN)).rejects.toThrow(
      'delay must be a finite number'
    );
    await expect(manager.moveToDelayed(waiting.id, Number.NaN)).rejects.toThrow(
      'delay must be a finite number'
    );
    await expect(manager.changeWaitingDelay(waiting.id, Infinity)).rejects.toThrow(
      'delay must be a finite number'
    );
    expect(Number.isFinite((await manager.getJob(waiting.id))?.runAt)).toBe(true);

    await expect(manager.pullWithLock('emb-cmd-lock', 'w1', 0, Number.NaN)).rejects.toThrow(
      'lockTtl must be a finite number'
    );
    await expect(manager.pullBatchWithLock('emb-cmd-lock', 1, 'w1', 0, Infinity)).rejects.toThrow(
      'lockTtl must be a finite number'
    );

    await manager.push('emb-cmd-lease', { data: {} });
    const { job, token } = await manager.pullWithLock('emb-cmd-lease', 'w1');
    expect(job).not.toBeNull();
    await expect(manager.extendLock(job!.id, token, Number.NaN)).rejects.toThrow(
      'duration must be a finite number'
    );
    expect(() => manager!.renewJobLock(job!.id, token!, Infinity)).toThrow(
      'duration must be a finite number'
    );
    expect(Number.isFinite(manager.getLockInfo(job!.id)?.expiresAt)).toBe(true);
  });
});
