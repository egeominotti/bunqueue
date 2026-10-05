/**
 * Repro (2.9.10 compatibility): ChangePriority `lifo` and priority, and `backoff` without
 * `delay`.
 *
 * - ChangePriority with a non-boolean `lifo` (`1`, `0`) was refused (`lifo must be a
 *   boolean`). 2.9.10 applied the change, and a 2.9.10 client ignores the reply, so the
 *   job was left silently unchanged. PUSH normalizes `lifo` to a boolean; ChangePriority
 *   must do the same and apply the change.
 * - `changePriority({ lifo: true })` without `priority` was refused (`priority is
 *   required`). 2.9.10 over TCP (and BullMQ) applied priority 0; embedded 2.9.10 failed on
 *   a SQLite NOT NULL. Both modes must apply priority 0.
 * - `backoff: { type }` without `delay` was refused (`backoff.delay is required`), on
 *   every path including job scheduler templates, so a re-upsert at boot failed. It must
 *   be admitted with the default base delay createJob falls back to (1000 ms); a NaN,
 *   negative or non-numeric `delay` stays refused.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import type { Command } from '../src/domain/types/command';
import { jobId } from '../src/domain/types/job';
import { handleCommand } from '../src/infrastructure/server/handler';
import type { HandlerContext } from '../src/infrastructure/server/types';
import { CoreE2eHarness, type CoreE2eMode } from './core-e2e/support/harness';

let manager: QueueManager | null = null;
let harness: CoreE2eHarness | null = null;
let sequence = 0;

afterEach(async () => {
  manager?.shutdown();
  manager = null;
  await harness?.close();
  harness = null;
});

type Reply = Record<string, unknown> & { ok: boolean; error?: string };

/** The exact command a 2.9.10 client sends, handled by the new server. */
async function send(command: Record<string, unknown>): Promise<Reply> {
  manager ??= new QueueManager();
  const context: HandlerContext = {
    queueManager: manager,
    authTokens: new Set<string>(),
    authenticated: false,
  };
  return (await handleCommand(command as unknown as Command, context)) as Reply;
}

async function pushed(extra: Record<string, unknown> = {}): Promise<string> {
  const reply = await send({
    cmd: 'PUSH',
    queue: `compat-pb-${++sequence}`,
    name: 'j',
    data: {},
    ...extra,
  });
  if (!reply.ok) throw new Error(String(reply.error));
  return String(reply.id);
}

async function stored(id: string) {
  const job = await manager!.getJob(jobId(id));
  return { priority: job?.priority, lifo: job?.lifo };
}

function outcome(reply: Reply): string {
  return reply.ok ? 'ok' : `error: ${String(reply.error)}`;
}

describe('a 2.9.10 client: ChangePriority applies a non-boolean lifo and a missing priority', () => {
  test('lifo 1, 0 and "yes" are normalized like PUSH and the change is applied', async () => {
    const results: Record<string, unknown> = {};
    for (const [label, lifo] of [
      ['1', 1],
      ['0', 0],
      ['"yes"', 'yes'],
    ] as const) {
      const id = await pushed({ priority: 2, lifo: label === '0' });
      const reply = await send({ cmd: 'ChangePriority', id, priority: 5, lifo });
      results[label] = { reply: outcome(reply), ...(await stored(id)) };
    }
    expect(results).toEqual({
      '1': { reply: 'ok', priority: 5, lifo: true },
      '0': { reply: 'ok', priority: 5, lifo: false },
      '"yes"': { reply: 'ok', priority: 5, lifo: true },
    });
  });

  test('a missing priority is 0, with or without lifo', async () => {
    const plain = await pushed({ priority: 7 });
    expect(outcome(await send({ cmd: 'ChangePriority', id: plain }))).toBe('ok');
    expect(await stored(plain)).toEqual({ priority: 0, lifo: false });
    const withLifo = await pushed({ priority: 7 });
    expect(outcome(await send({ cmd: 'ChangePriority', id: withLifo, lifo: true }))).toBe('ok');
    expect(await stored(withLifo)).toEqual({ priority: 0, lifo: true });
  });

  test('only a NaN or non-numeric priority is still refused', async () => {
    const id = await pushed({ priority: 7 });
    expect(outcome(await send({ cmd: 'ChangePriority', id, priority: Number.NaN }))).toBe(
      'error: priority must be a finite number'
    );
    expect(outcome(await send({ cmd: 'ChangePriority', id, priority: 'high' }))).toBe(
      'error: priority must be a number'
    );
    expect(await stored(id)).toEqual({ priority: 7, lifo: false });
  });

  test('QueueManager.changePriority (embedded and bunqueue/queue) agrees', async () => {
    const id = await pushed({ priority: 7 });
    await expect(
      manager!.changePriority(jobId(id), undefined as unknown as number, true)
    ).resolves.toBe(true);
    expect(await stored(id)).toEqual({ priority: 0, lifo: true });
    await expect(manager!.changePriority(jobId(id), 4, 1 as unknown as boolean)).resolves.toBe(
      true
    );
    expect(await stored(id)).toEqual({ priority: 4, lifo: true });
  });
});

describe('a 2.9.10 client: backoff without delay uses the 1000 ms default', () => {
  test('PUSH, PUSHB and Cron accept it', async () => {
    const id = await pushed({ backoff: { type: 'exponential' } });
    const job = await manager!.getJob(jobId(id));
    expect(job?.backoffConfig).toEqual({ type: 'exponential', delay: 1000 });
    expect(job?.backoff).toBe(1000);
    const batch = await send({
      cmd: 'PUSHB',
      queue: 'compat-pb-batch',
      jobs: [{ name: 'j', data: {}, backoff: { type: 'fixed' } }],
    });
    expect(outcome(batch)).toBe('ok');
    const cron = await send({
      cmd: 'Cron',
      name: 'compat-pb-cron',
      queue: 'compat-pb-cron',
      data: {},
      repeatEvery: 60_000,
      jobOptions: { backoff: { type: 'fixed' } },
    });
    expect(outcome(cron)).toBe('ok');
  });

  test('a NaN, negative or non-numeric delay is still refused', async () => {
    const results: Record<string, string> = {};
    for (const [label, delay] of [
      ['NaN', Number.NaN],
      ['-1', -1],
      ['"soon"', 'soon'],
    ] as const) {
      results[label] = outcome(
        await send({
          cmd: 'PUSH',
          queue: 'compat-pb-bad',
          name: 'j',
          data: {},
          backoff: { type: 'fixed', delay },
        })
      );
    }
    expect(results).toEqual({
      NaN: 'error: backoff.delay must be a finite number',
      '-1': 'error: backoff.delay must be at least 0',
      '"soon"': 'error: backoff.delay must be a number',
    });
  });
});

for (const mode of ['embedded', 'tcp'] as CoreE2eMode[]) {
  describe(`job methods and adds (${mode})`, () => {
    test('changePriority({ lifo: true }) without priority applies priority 0', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-pb-change');
      const queue = harness.queue('compat-pb-change');
      const job = await queue.add('t', {}, { priority: 6 });
      await job.changePriority({ lifo: true } as never);
      const read = await harness.brokerManager().getJob(jobId(String(job.id)));
      expect({ priority: read?.priority, lifo: read?.lifo }).toEqual({ priority: 0, lifo: true });
      await queue.changeJobPriority(String(job.id), { priority: 3, lifo: 1 as never });
      const again = await harness.brokerManager().getJob(jobId(String(job.id)));
      expect({ priority: again?.priority, lifo: again?.lifo }).toEqual({ priority: 3, lifo: true });
    });

    test('add, addBulk, flows and a job scheduler accept backoff without delay', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-pb-backoff');
      const manager = harness.brokerManager();
      const queue = harness.queue('compat-pb-backoff');
      const backoff = { type: 'exponential' } as never;
      const added = await queue.add('a', {}, { backoff, attempts: 2 });
      expect((await manager.getJob(jobId(String(added.id))))?.backoffConfig).toEqual({
        type: 'exponential',
        delay: 1000,
      });
      expect(await queue.addBulk([{ name: 'b', data: {}, opts: { backoff } }])).toHaveLength(1);
      const flow = harness.flow();
      await expect(
        flow.add({ name: 'p', queueName: queue.name, data: {}, opts: { backoff } })
      ).resolves.toBeDefined();
      await expect(
        queue.upsertJobScheduler('s', { every: 60_000 }, { name: 't', opts: { backoff } })
      ).resolves.not.toBeNull();
      await expect(
        queue.add('bad', {}, { backoff: { type: 'fixed', delay: Number.NaN } })
      ).rejects.toThrow('backoff.delay must be a finite number');
    });
  });
}
