/**
 * Repro (2.9.10 compatibility): a past run time, a negative `attempts`, and long
 * direct pull waits.
 *
 * - 2.9.10 stored `runAt = now + delay` for a negative job `delay` (embedded add) and
 *   for a negative ChangeDelay/MoveToDelayed `delay` (both modes). The waiting-queue
 *   comparator orders ready jobs by `runAt`, so such a job ran AHEAD of earlier ready
 *   jobs. The candidate clamped the delay to 0, which put it behind them: a change of
 *   queue order. Every path (embedded, TCP, HTTP, Cloud; PostgreSQL for a job `delay`)
 *   must keep the past run time again (bounded only to the honoured duration range), with
 *   the job ready, never `delayed`. The public `moveToDelayed(timestamp)` keeps 2.9.10's client-side
 *   `max(0, timestamp - now)` (a numeric-string timestamp coerced, as 2.9.10's `-` did),
 *   and the PostgreSQL engine keeps its own 2.9.10 clamp of a negative ChangeDelay to now
 *   (the engines differed on 2.9.10).
 * - `attempts: -1` ran the job exactly once on 2.9.10 embedded (`attempts <
 *   maxAttempts` is false after the first failure); the candidate refused it.
 * - A direct `QueueManager.pull*` wait above 60 s was honoured by 2.9.10; the
 *   candidate capped it at 60 s.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { PostgresQueueManager } from '../src/application/postgresQueueManager';
import { QueueManager } from '../src/application/queueManager';
import { createJob } from '../src/domain/job/create';
import { MAX_JOB_DURATION_MS, pullTimeoutArgument } from '../src/domain/job/options';
import { NEVER_DEADLINE, processingDeadline } from '../src/domain/job/timeoutRule';
import type { Command } from '../src/domain/types/command';
import { jobId } from '../src/domain/types/job';
import { handleCommand as handleCloud } from '../src/infrastructure/cloud/commandHandler';
import { handleCommand } from '../src/infrastructure/server/handler';
import type { HandlerContext } from '../src/infrastructure/server/types';
import { delayUntil } from '../src/client/queue/commandArgs';
import { CoreE2eHarness, type CoreE2eMode } from './core-e2e/support/harness';
import { cleanupPostgresNamespace } from './support/postgres-event-race';

const PAST = -5_000;
const postgresUrl = Bun.env.BUNQUEUE_TEST_POSTGRES_URL;
const namespace = `test-compat-past-run-${Date.now()}-${crypto.randomUUID()}`;

let harness: CoreE2eHarness | null = null;
let manager: QueueManager | null = null;
let postgres: PostgresQueueManager | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
  manager?.shutdown();
  manager = null;
});

afterAll(async () => {
  await postgres?.shutdownPostgres();
  if (postgresUrl) await cleanupPostgresNamespace(postgresUrl, namespace);
});

async function drainNames(broker: QueueManager, queue: string): Promise<string[]> {
  const names: string[] = [];
  for (;;) {
    const job = await broker.pull(queue, 0);
    if (!job) return names;
    names.push(job.name);
  }
}

async function send(command: Record<string, unknown>) {
  manager ??= new QueueManager();
  const context: HandlerContext = {
    queueManager: manager,
    authTokens: new Set<string>(),
    authenticated: false,
  };
  return (await handleCommand(command as unknown as Command, context)) as Record<
    string,
    unknown
  > & { ok: boolean };
}

describe('a stored non-finite timeout keeps its 2.9.10 meaning (no timeout)', () => {
  test('normalization never turns ±Infinity into a finite deadline', () => {
    const now = 1_700_000_000_000;
    for (const timeout of [Infinity, -Infinity]) {
      const job = createJob(jobId('inf'), 'q', { data: {}, timeout }, now);
      expect(job.timeout).toBe(timeout);
      expect(processingDeadline({ timeout: job.timeout, startedAt: now })).toBe(NEVER_DEADLINE);
    }
  });
});

describe('createJob keeps a past run time, bounded to the honoured range', () => {
  test('runAt = createdAt + delay for a negative delay', () => {
    const now = 1_700_000_000_000;
    expect(createJob(jobId('neg'), 'q', { data: {}, delay: PAST }, now).runAt).toBe(now + PAST);
    expect(createJob(jobId('far'), 'q', { data: {}, delay: -1e300 }, now).runAt).toBe(
      now - MAX_JOB_DURATION_MS
    );
  });
});

for (const mode of ['embedded', 'tcp'] as CoreE2eMode[]) {
  describe(`a past run time goes ahead of earlier ready jobs (${mode})`, () => {
    test('add with a negative delay', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-past-add');
      const queue = harness.queue('compat-past-add');
      const broker = harness.brokerManager();
      await queue.add('first', {});
      const late = await queue.add('late', {}, { delay: PAST });
      const stored = await broker.getJob(jobId(String(late.id)));
      expect(stored!.runAt).toBe(stored!.createdAt + PAST);
      expect(await queue.getJobState(String(late.id))).toBe('waiting');
      expect(broker.getMemoryStats().delayedHeapTotal).toBe(0);
      expect(await drainNames(broker, queue.name)).toEqual(['late', 'first']);
    });

    test('changeDelay with a negative delay', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-past-change');
      const queue = harness.queue('compat-past-change');
      const broker = harness.brokerManager();
      await queue.add('first', {});
      const moved = await queue.add('moved', {}, { delay: 60_000 });
      await moved.changeDelay(PAST);
      expect(await queue.getJobState(String(moved.id))).toBe('waiting');
      expect(await drainNames(broker, queue.name)).toEqual(['moved', 'first']);
    });

    test('attempts: -1 is admitted and runs the job once', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-negative-attempts');
      const queue = harness.queue('compat-negative-attempts');
      const job = await queue.add('t', {}, { attempts: -1 });
      expect((await harness.brokerManager().getJob(jobId(String(job.id))))?.maxAttempts).toBe(1);
      let runs = 0;
      harness.worker(queue.name, () => {
        runs++;
        throw new Error('boom');
      });
      const deadline = Date.now() + 5_000;
      while ((await queue.getJobState(String(job.id))) !== 'failed' && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect(await queue.getJobState(String(job.id))).toBe('failed');
      expect(runs).toBe(1);
    });
  });
}

describe('a 2.9.10 client: wire commands with a past run time', () => {
  test('PUSH with a negative delay goes ahead; MoveToDelayed -5000 too', async () => {
    await send({ cmd: 'PUSH', queue: 'wire-past', name: 'first', data: {} });
    const late = await send({
      cmd: 'PUSH',
      queue: 'wire-past',
      name: 'late',
      data: {},
      delay: PAST,
    });
    expect(late.ok).toBe(true);
    expect(await drainNames(manager!, 'wire-past')).toEqual(['late', 'first']);

    await send({ cmd: 'PUSH', queue: 'wire-move', name: 'active', data: {} });
    const pulled = await send({ cmd: 'PULL', queue: 'wire-move', owner: 'w', timeout: 0 });
    await send({ cmd: 'PUSH', queue: 'wire-move', name: 'first', data: {} });
    const job = pulled.job as { id: string };
    const moved = await send({
      cmd: 'MoveToDelayed',
      id: job.id,
      delay: PAST,
      token: pulled.token,
    });
    expect(moved.ok).toBe(true);
    expect(await manager!.getJobState(jobId(job.id))).toBe('waiting');
    expect(await drainNames(manager!, 'wire-move')).toEqual(['active', 'first']);
  });

  test('PUSH maxAttempts -1 is admitted as 1', async () => {
    const reply = await send({
      cmd: 'PUSH',
      queue: 'wire-att',
      name: 'j',
      data: {},
      maxAttempts: -1,
    });
    expect(reply.ok).toBe(true);
    expect((await manager!.getJob(jobId(String(reply.id))))?.maxAttempts).toBe(1);
  });

  test('Cloud job:delay with a negative delay goes ahead too', async () => {
    manager = new QueueManager();
    await manager.push('cloud-past', { name: 'first', data: {} });
    const moved = await manager.push('cloud-past', { name: 'moved', data: {}, delay: 60_000 });
    const result = await handleCloud(manager, {
      type: 'command',
      id: 'c',
      action: 'job:delay',
      jobId: String(moved.id),
      delay: PAST,
    } as never);
    expect(result).toMatchObject({ success: true });
    expect(await drainNames(manager, 'cloud-past')).toEqual(['moved', 'first']);
  });
});

describe('direct QueueManager pull waits are not capped at 60 s', () => {
  test('pullTimeoutArgument keeps a long wait; negative and NaN are no wait', () => {
    expect([120_000, 3_600_000, Infinity, -1, Number.NaN].map(pullTimeoutArgument)).toEqual([
      120_000,
      3_600_000,
      Infinity,
      0,
      0,
    ]);
  });
});

describe('PostgreSQL keeps its own 2.9.10 results', () => {
  test.skipIf(!postgresUrl)(
    'push keeps a past run time; changeDelay clamps a negative delay to now',
    async () => {
      postgres = new PostgresQueueManager({
        postgres: { url: postgresUrl!, namespace, brokerId: 'compat-past' },
      });
      await postgres.waitUntilReady();
      await postgres.push('pg-past', { name: 'first', data: {} });
      const late = await postgres.push('pg-past', { name: 'late', data: {}, delay: PAST });
      expect(late.runAt).toBe(late.createdAt + PAST);
      const moved = await postgres.push('pg-past', { name: 'moved', data: {}, delay: 60_000 });
      const before = Date.now();
      // 2.9.10's PostgreSQL engine applied `now + Math.max(0, delay)`; the engines differed.
      expect(await postgres.changeDelay(moved.id, PAST * 2)).toBe(true);
      expect(await postgres.getJobState(moved.id)).toBe('waiting');
      expect((await postgres.getJob(moved.id))!.runAt).toBeGreaterThanOrEqual(before - 1_000);
      const order: string[] = [];
      for (let index = 0; index < 3; index++) {
        order.push((await postgres.pull('pg-past', 0))?.name ?? '-');
      }
      expect(order).toEqual(['late', 'first', 'moved']);
    }
  );
});

describe('moveToDelayed accepts a numeric-string timestamp, as 2.9.10 coerced it', () => {
  test('delayUntil reads a plain decimal string as its number; past means now', () => {
    const future = Date.now() + 60_000;
    expect(delayUntil(String(future))).toBeGreaterThan(55_000);
    expect(delayUntil(String(Date.now() - 5_000))).toBe(0);
    expect(() => delayUntil('soon')).toThrow('timestamp must be a number');
    expect(() => delayUntil(Number.NaN)).toThrow('timestamp must be a finite number');
  });

  for (const mode of ['embedded', 'tcp'] as CoreE2eMode[]) {
    test(`job.moveToDelayed('<epoch ms>') delays a waiting job (${mode})`, async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-move-string');
      const queue = harness.queue('compat-move-string');
      const job = await queue.add('t', {});
      await job.moveToDelayed(String(Date.now() + 60_000) as never);
      expect(await queue.getJobState(String(job.id))).toBe('delayed');
    });
  }
});
