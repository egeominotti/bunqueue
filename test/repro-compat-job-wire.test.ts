/**
 * Repro (2.9.10 compatibility): a 2.9.10 client against the new server.
 *
 * These are the exact commands a 2.9.10 client (or any client built against the
 * 2.9.10 wire contract) sends. The candidate server refused several of them, and the
 * 2.9.10 client ignores most of those replies, so the failure was silent:
 *
 * - PULL/PULLB `lockTtl` 0, -1 or 0.5 (a Worker with `lockDuration: 0`) were refused,
 *   which a 2.9.10 Worker reads as an empty queue: nothing was processed;
 * - ExtendLock(s)/JobHeartbeat durations 0, -1 or 0.5 were refused (2.9.10: ok);
 * - PUSH/PUSHB fields 2.9.10 never range-checked over TCP (stallTimeout 48 h,
 *   sizeLimit 20 MB, keepLogs 2e6/10.5/-1, stackTraceLimit 50000/2.5, dedup.ttl and
 *   debounceTtl and repeat.every of 400 days, timestamp -1) were refused;
 * - Progress `'50'`, `true`, `null` was not stored (2.9.10 stored 50, 1, 0);
 * - ChangePriority 1.5, 2e6, `'5'` and grouped -1/2.5/5e6 left the job unchanged;
 * - ClearLogs keepLogs -1, 2.5, `'3'`, 2e6 was refused (2.9.10: all, 2, 3, none cleared);
 * - ChangeDelay/MoveToDelayed -1 (a past run time) and 400 days were refused;
 * - Update with 11 MB of data was refused, although PUSH of the same data succeeds;
 * - Cron templates with values 2.9.10 stored (timeout/stallTimeout above 24 h,
 *   maxAttempts 0, priority 1.5/2e6, repeatEvery/dedup.ttl of 400 days) were refused.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import type { Command } from '../src/domain/types/command';
import { jobId } from '../src/domain/types/job';
import { handleCommand } from '../src/infrastructure/server/handler';
import type { HandlerContext } from '../src/infrastructure/server/types';

const DAY = 86_400_000;
let manager: QueueManager | null = null;
let sequence = 0;

afterEach(() => {
  manager?.shutdown();
  manager = null;
});

type Reply = Record<string, unknown> & { ok: boolean; error?: string };

async function send(command: Record<string, unknown>): Promise<Reply> {
  manager ??= new QueueManager();
  const context: HandlerContext = {
    queueManager: manager,
    authTokens: new Set<string>(),
    authenticated: false,
  };
  return (await handleCommand(command as unknown as Command, context)) as Reply;
}

function queue(): string {
  return `compat-wire-${++sequence}`;
}

function outcome(reply: Reply): string {
  return reply.ok ? 'ok' : `error: ${String(reply.error)}`;
}

async function pushed(extra: Record<string, unknown> = {}): Promise<string> {
  const reply = await send({ cmd: 'PUSH', queue: queue(), name: 'j', data: {}, ...extra });
  if (!reply.ok) throw new Error(String(reply.error));
  return String(reply.id);
}

async function active(): Promise<{ id: string; token: string; queue: string }> {
  const name = queue();
  await send({ cmd: 'PUSH', queue: name, name: 'j', data: {} });
  const reply = await send({ cmd: 'PULL', queue: name, owner: 'w1', timeout: 0 });
  const job = reply.job as { id: string };
  return { id: job.id, token: String(reply.token), queue: name };
}

async function stored(id: string) {
  return manager!.getJob(jobId(id));
}

describe('a 2.9.10 Worker with lockDuration 0 still processes jobs (A)', () => {
  test('PULL/PULLB accept every finite lockTtl and the ACK succeeds', async () => {
    const results: Record<string, string> = {};
    for (const lockTtl of [0, -1, 0.5, 30_000.5]) {
      const name = queue();
      await send({ cmd: 'PUSH', queue: name, name: 'j', data: {} });
      const pulled = await send({ cmd: 'PULL', queue: name, owner: 'w1', timeout: 0, lockTtl });
      const job = pulled.job as { id: string } | null;
      const ack = job ? await send({ cmd: 'ACK', id: job.id, token: pulled.token }) : null;
      results[`PULL ${lockTtl}`] =
        `${outcome(pulled)} job=${Boolean(job)} ack=${ack ? outcome(ack) : '-'}`;
      const batchQueue = queue();
      await send({ cmd: 'PUSH', queue: batchQueue, name: 'j', data: {} });
      const batch = await send({
        cmd: 'PULLB',
        queue: batchQueue,
        count: 5,
        owner: 'w1',
        timeout: 0,
        lockTtl,
      });
      results[`PULLB ${lockTtl}`] =
        `${outcome(batch)} n=${(batch.jobs as unknown[] | undefined)?.length}`;
    }
    const expected: Record<string, string> = {};
    for (const lockTtl of [0, -1, 0.5, 30_000.5]) {
      expected[`PULL ${lockTtl}`] = 'ok job=true ack=ok';
      expected[`PULLB ${lockTtl}`] = 'ok n=1';
    }
    expect(results).toEqual(expected);
    const nan = await send({ cmd: 'PULL', queue: queue(), owner: 'w1', lockTtl: Number.NaN });
    expect(outcome(nan)).toBe('error: lockTtl must be a finite number');
  });
});

describe('lease renewals with any finite duration reply ok (B)', () => {
  test('ExtendLock, ExtendLocks and JobHeartbeat', async () => {
    const results: Record<string, string> = {};
    for (const duration of [0, -1, 0.5]) {
      const a = await active();
      results[`ExtendLock ${duration}`] = outcome(
        await send({ cmd: 'ExtendLock', id: a.id, token: a.token, duration })
      );
      const b = await active();
      const many = await send({
        cmd: 'ExtendLocks',
        ids: [b.id],
        tokens: [b.token],
        durations: [duration],
      });
      results[`ExtendLocks ${duration}`] = `${outcome(many)} count=${String(many.count)}`;
      const c = await active();
      results[`JobHeartbeat ${duration}`] = outcome(
        await send({ cmd: 'JobHeartbeat', id: c.id, token: c.token, duration })
      );
    }
    expect(results).toEqual({
      'ExtendLock 0': 'ok',
      'ExtendLocks 0': 'ok count=1',
      'JobHeartbeat 0': 'ok',
      'ExtendLock -1': 'ok',
      'ExtendLocks -1': 'ok count=1',
      'JobHeartbeat -1': 'ok',
      'ExtendLock 0.5': 'ok',
      'ExtendLocks 0.5': 'ok count=1',
      'JobHeartbeat 0.5': 'ok',
    });
  });
});

describe('PUSH/PUSHB fields 2.9.10 never range-checked are admitted (C)', () => {
  test('values that broke nothing are stored as given', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['stallTimeout 48h', { stallTimeout: 2 * DAY }],
      ['stallTimeout -1', { stallTimeout: -1 }],
      ['keepLogs 2e6', { keepLogs: 2_000_000 }],
      ['keepLogs 10.5', { keepLogs: 10.5 }],
      ['keepLogs -1', { keepLogs: -1 }],
      ['stackTraceLimit 50000', { stackTraceLimit: 50_000 }],
      ['stackTraceLimit 2.5', { stackTraceLimit: 2.5 }],
      ['sizeLimit 20MB', { sizeLimit: 20 * 1024 * 1024 }],
      ['sizeLimit 1000.5', { sizeLimit: 1000.5 }],
      ['dedup.ttl 400d', { uniqueKey: 'u-400', dedup: { ttl: 400 * DAY } }],
      ['dedup.ttl -1', { uniqueKey: 'u-neg', dedup: { ttl: -1 } }],
      ['debounceTtl 400d', { debounceId: 'd-400', debounceTtl: 400 * DAY }],
      ['repeat.every 400d', { repeat: { every: 400 * DAY } }],
      ['timestamp -1', { timestamp: -1 }],
    ];
    const results: Record<string, string> = {};
    for (const [label, fields] of cases) {
      results[`PUSH ${label}`] = outcome(
        await send({ cmd: 'PUSH', queue: queue(), name: 'j', data: {}, ...fields })
      );
      const batchFields = { ...fields };
      if ('uniqueKey' in batchFields) batchFields.uniqueKey = `${String(fields.uniqueKey)}-b`;
      if ('debounceId' in batchFields) batchFields.debounceId = `${String(fields.debounceId)}-b`;
      results[`PUSHB ${label}`] = outcome(
        await send({
          cmd: 'PUSHB',
          queue: queue(),
          jobs: [{ name: 'j', data: {}, ...batchFields }],
        })
      );
    }
    const expected = Object.fromEntries(Object.keys(results).map((key) => [key, 'ok']));
    expect(results).toEqual(expected);

    const id = await pushed({ stallTimeout: 2 * DAY, keepLogs: 10.5, timestamp: -1 });
    const job = await stored(id);
    expect({
      stallTimeout: job?.stallTimeout,
      keepLogs: job?.keepLogs,
      createdAt: job?.createdAt,
    }).toEqual({ stallTimeout: 2 * DAY, keepLogs: 10.5, createdAt: -1 });
  });

  test('NaN still guards real breakage', async () => {
    const reply = await send({
      cmd: 'PUSH',
      queue: queue(),
      name: 'j',
      data: {},
      stallTimeout: Number.NaN,
    });
    expect(outcome(reply)).toBe('error: stallTimeout must be a finite number');
  });
});

describe('Progress stores what 2.9.10 stored (2)', () => {
  test('numeric strings, booleans and null are numbers; text is the message', async () => {
    const results: Record<string, unknown> = {};
    for (const [label, progress, message] of [
      ["'50'", '50', 'm'],
      ['true', true, 'm'],
      ['null', null, 'm'],
      ['NaN', Number.NaN, 'm'],
      ["'downloading'", 'downloading', undefined],
    ] as const) {
      const a = await active();
      const reply = await send({ cmd: 'Progress', id: a.id, progress, message });
      const read = await send({ cmd: 'GetProgress', id: a.id });
      results[label] = `${outcome(reply)} ${String(read.progress)} ${String(read.message)}`;
    }
    expect(results).toEqual({
      "'50'": 'ok 50 m',
      true: 'ok 1 m',
      null: 'ok 0 m',
      NaN: 'ok 0 m',
      "'downloading'": 'ok 0 downloading',
    });
  });
});

describe('ChangePriority applies every finite priority (D, 7)', () => {
  test('fractional, above 1e6 and numeric strings are applied', async () => {
    const results: Record<string, unknown> = {};
    for (const [label, priority] of [
      ['1.5', 1.5],
      ['2e6', 2_000_000],
      ["'5'", '5'],
    ] as const) {
      const id = await pushed();
      const reply = await send({ cmd: 'ChangePriority', id, priority });
      results[label] = `${outcome(reply)} ${String((await stored(id))?.priority)}`;
    }
    const grouped = await pushed({ groupId: 'grp', priority: 3 });
    for (const priority of [-1, 2.5, 5_000_000]) {
      const reply = await send({ cmd: 'ChangePriority', id: grouped, priority });
      results[`grouped ${priority}`] =
        `${outcome(reply)} ${String((await stored(grouped))?.priority)}`;
    }
    expect(results).toEqual({
      '1.5': 'ok 1.5',
      '2e6': 'ok 2000000',
      "'5'": 'ok 5',
      'grouped -1': 'ok -1',
      'grouped 2.5': 'ok 2.5',
      'grouped 5000000': 'ok 5000000',
    });
    const id = await pushed();
    expect(outcome(await send({ cmd: 'ChangePriority', id, priority: Number.NaN }))).toBe(
      'error: priority must be a finite number'
    );
    // A non-boolean lifo is normalized like PUSH (repro-compat-job-priority-backoff).
    expect(outcome(await send({ cmd: 'ChangePriority', id, priority: 5, lifo: 1 }))).toBe('ok');
    expect((await stored(id))?.lifo).toBe(true);
  });
});

describe('ClearLogs keeps what 2.9.10 kept (14, H)', () => {
  test('negative clears all, fractions floor, strings coerce, huge keeps all', async () => {
    const results: Record<string, number> = {};
    for (const keepLogs of [-1, 2.5, '3', 2_000_000, 0]) {
      const a = await active();
      for (let index = 0; index < 5; index++) {
        await send({ cmd: 'AddLog', id: a.id, message: `l${index}` });
      }
      const reply = await send({ cmd: 'ClearLogs', id: a.id, keepLogs });
      expect(outcome(reply)).toBe('ok');
      const logs = await send({ cmd: 'GetLogs', id: a.id });
      results[JSON.stringify(keepLogs)] = (logs.data as { logs: unknown[] }).logs.length;
    }
    expect(results).toEqual({ '-1': 0, '2.5': 2, '"3"': 3, '2000000': 5, '0': 0 });
  });
});

describe('ChangeDelay/MoveToDelayed accept a past or distant run time (4, 11)', () => {
  test('-1 makes the job ready and 400 days delays it', async () => {
    const results: Record<string, string> = {};
    for (const delay of [-1, 400 * DAY]) {
      const id = await pushed({ delay: 60_000 });
      const reply = await send({ cmd: 'ChangeDelay', id, delay });
      results[`ChangeDelay ${delay}`] =
        `${outcome(reply)} ${String((await send({ cmd: 'GetState', id })).state)}`;
      const a = await active();
      const moved = await send({ cmd: 'MoveToDelayed', id: a.id, delay, token: a.token });
      results[`MoveToDelayed ${delay}`] =
        `${outcome(moved)} ${String((await send({ cmd: 'GetState', id: a.id })).state)}`;
    }
    expect(results).toEqual({
      'ChangeDelay -1': 'ok waiting',
      'MoveToDelayed -1': 'ok waiting',
      [`ChangeDelay ${400 * DAY}`]: 'ok delayed',
      [`MoveToDelayed ${400 * DAY}`]: 'ok delayed',
    });
  });
});

describe('Update and Cron accept what 2.9.10 accepted (5, 1)', () => {
  test('Update with 11 MB of data, as PUSH of the same data', async () => {
    const id = await pushed();
    const reply = await send({ cmd: 'Update', id, data: { blob: 'x'.repeat(11 * 1024 * 1024) } });
    expect(outcome(reply)).toBe('ok');
  });

  test('Cron templates 2.9.10 stored', async () => {
    const cases: Record<string, Record<string, unknown>> = {
      'stallTimeout 48h': { repeatEvery: 60_000, jobOptions: { stallTimeout: 2 * DAY } },
      'timeout 25h': { repeatEvery: 60_000, jobOptions: { timeout: 25 * 3_600_000 } },
      'maxAttempts 0': { repeatEvery: 60_000, jobOptions: { maxAttempts: 0 } },
      'backoff 25h': { repeatEvery: 60_000, jobOptions: { backoff: 25 * 3_600_000 } },
      'delay 366d': { repeatEvery: 60_000, jobOptions: { delay: 366 * DAY } },
      'priority 1.5': { repeatEvery: 60_000, priority: 1.5 },
      'priority 2e6': { repeatEvery: 60_000, priority: 2_000_000 },
      'repeatEvery 400d': { repeatEvery: 400 * DAY },
      'dedup.ttl 400d': { repeatEvery: 60_000, uniqueKey: 'cu', dedup: { ttl: 400 * DAY } },
    };
    const results: Record<string, string> = {};
    for (const [label, fields] of Object.entries(cases)) {
      results[label] = outcome(
        await send({ cmd: 'Cron', name: `c-${label}`, queue: queue(), data: {}, ...fields })
      );
    }
    expect(results).toEqual(Object.fromEntries(Object.keys(cases).map((key) => [key, 'ok'])));
  });
});
