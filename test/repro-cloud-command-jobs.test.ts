/**
 * Repro: the Cloud command channel bypassed the job validation every other admission
 * path applies, and could emit timestamps no Date accepts.
 *
 * - `job:push` handed `queue`, `data`, `priority` and `delay` straight to
 *   `QueueManager.push`. TCP PUSH rejects an invalid queue name, oversized data and
 *   invalid options (`validateQueueName`, `validateJobData`, `validateJobOptions`); the
 *   remote command created the job anyway (a NaN delay or priority). Values 2.9.10 ran
 *   (a 2e6 or fractional priority, a 400-day delay) are admitted on both paths.
 * - `job:listAll` sliced with an unvalidated `limit`/`offset` (NaN returned nothing).
 * - `job:delay` did `command.delay ?? 0`: a command without a delay made a delayed job
 *   ready at once instead of being rejected like TCP ChangeDelay.
 * - `job:clearLogs` passed `keepLogs` through unchecked: NaN kept every log silently (and
 *   the PostgreSQL adapter bypasses QueueManager.clearLogs). Numbers keep 2.9.10's
 *   meaning (a negative value clears all, a fraction keeps its whole part).
 * - A legacy job whose run time is ±Infinity (an old SQLite row) left both Cloud wire
 *   encodings (msgpack, HTTP and WebSocket) as ±Infinity, which the dashboard cannot
 *   turn into a date: `new Date(Infinity).toISOString()` throws a RangeError.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { pack, unpack } from 'msgpackr';
import { QueueManager } from '../src/application/queueManager';
import { createJob } from '../src/domain/job/create';
import { jobId } from '../src/domain/types/job';
import { handleCommand as handleCloud } from '../src/infrastructure/cloud/commandHandler';
import { JOB_COMMANDS } from '../src/infrastructure/cloud/commands/jobs';
import type { CloudQueueAdapter } from '../src/infrastructure/cloud/queueAdapter/types';
import { mapCloudCommandJob } from '../src/infrastructure/cloud/commands/jobMapper';
import { mapSnapshotJobs } from '../src/infrastructure/cloud/snapshotHelpers';
import { handleCommand as handleTcp } from '../src/infrastructure/server/handler';

const managers: QueueManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
});

function manager(): QueueManager {
  const created = new QueueManager();
  managers.push(created);
  return created;
}

const INVALID_PUSHES: Array<[string, Record<string, unknown>]> = [
  ['NaN priority', { priority: Number.NaN }],
  ['non-numeric priority', { priority: 'high' }],
  // A negative delay is accepted and means 0 (repro-job-options-negative-delay); a
  // priority above 1e6, a fraction or a 400-day delay are admitted, as on 2.9.10.
  ['NaN delay', { delay: Number.NaN }],
  ['non-numeric delay', { delay: 'soon' }],
  ['invalid queue name', { queue: 'bad queue!' }],
  ['missing queue name', { queue: '' }],
];

describe('job:push validates like TCP PUSH', () => {
  test.each(INVALID_PUSHES)(
    'rejects %s with the TCP message, creating nothing',
    async (_l, fields) => {
      const queueManager = manager();
      const queue = (fields.queue as string | undefined) ?? 'cloud-push';
      const tcp = await handleTcp({ cmd: 'PUSH', queue, data: { n: 1 }, ...fields } as never, {
        queueManager,
        authTokens: new Set<string>(),
        authenticated: false,
        clientId: 't',
      });
      expect(tcp.ok).toBe(false);

      const cloud = await handleCloud(queueManager, {
        type: 'command',
        id: 'push-1',
        action: 'job:push',
        queue,
        data: { n: 1 },
        ...fields,
      } as never);
      expect(cloud).toEqual({
        type: 'command_result',
        id: 'push-1',
        success: false,
        error: (tcp as { error: string }).error,
      });
      expect(queueManager.getStats().waiting + queueManager.getStats().delayed).toBe(0);
    }
  );

  test('rejects data above the 10 MB limit', async () => {
    const queueManager = manager();
    const cloud = await handleCloud(queueManager, {
      type: 'command',
      id: 'push-big',
      action: 'job:push',
      queue: 'cloud-push',
      data: { blob: 'x'.repeat(10 * 1024 * 1024 + 1) },
    });
    expect(cloud).toEqual({
      type: 'command_result',
      id: 'push-big',
      success: false,
      error: 'Job data too large (max 10MB)',
    });
  });

  test('still pushes a valid job', async () => {
    const queueManager = manager();
    const cloud = await handleCloud(queueManager, {
      type: 'command',
      id: 'push-ok',
      action: 'job:push',
      queue: 'cloud-push',
      data: { n: 1 },
      priority: 5,
      delay: 60_000,
    });
    expect(cloud).toMatchObject({ success: true, data: { queue: 'cloud-push' } });
    expect(queueManager.getStats().delayed).toBe(1);
  });
});

test('job:listAll pages with sanitized limit and offset', async () => {
  const queueManager = manager();
  for (let i = 0; i < 3; i++) await queueManager.push('cloud-list', { data: { i } });
  const result = await handleCloud(queueManager, {
    type: 'command',
    id: 'list-1',
    action: 'job:listAll',
    limit: Number.NaN,
    offset: Number.NaN,
  });
  expect(result).toMatchObject({ success: true, data: { total: 3, offset: 0, limit: 50 } });
  expect((result as { data: { jobs: unknown[] } }).data.jobs).toHaveLength(3);
});

describe('legacy non-finite run times are emitted as valid dates', () => {
  const TIMESTAMP_KEYS = ['runAt', 'timestamp', 'createdAt', 'processedOn', 'startedAt'];

  function decodedDates(value: Record<string, unknown>): Record<string, string> {
    const decoded = unpack(pack(value)) as Record<string, unknown>;
    const dates: Record<string, string> = {};
    for (const key of TIMESTAMP_KEYS) {
      const ms = decoded[key];
      if (typeof ms !== 'number') continue;
      try {
        dates[key] = new Date(ms).toISOString();
      } catch (error) {
        dates[key] = `throws ${(error as Error).name}`;
      }
    }
    return dates;
  }

  test.each([
    ['Infinity', Number.POSITIVE_INFINITY, '+275760-09-13T00:00:00.000Z'],
    ['-Infinity', Number.NEGATIVE_INFINITY, '-271821-04-20T00:00:00.000Z'],
  ])('run time %s', (_label, runAt, expected) => {
    const job = createJob(jobId('legacy-1'), 'legacy', { data: {} }, 1_700_000_000_000);
    job.runAt = runAt;

    const command = decodedDates(mapCloudCommandJob(job));
    const [snapshot] = mapSnapshotJobs([{ job, state: 'delayed' }], {
      includeJobData: false,
      redactFields: [],
    });
    const snapshotDates = decodedDates(snapshot as unknown as Record<string, unknown>);

    expect(command.runAt).toBe(expected);
    expect(snapshotDates.runAt).toBe(expected);
    expect(command.timestamp).toBe('2023-11-14T22:13:20.000Z');
  });
});

describe('job:delay requires a delay and applies the ChangeDelay rule', () => {
  async function delayed(queueManager: QueueManager) {
    const job = await queueManager.push('cloud-delay', { data: { n: 1 }, delay: 60_000 });
    return String(job.id);
  }

  test('a missing delay is rejected and the job stays delayed', async () => {
    const queueManager = manager();
    const id = await delayed(queueManager);
    const result = await handleCloud(queueManager, {
      type: 'command',
      id: 'delay-missing',
      action: 'job:delay',
      jobId: id,
    });
    expect(result).toEqual({
      type: 'command_result',
      id: 'delay-missing',
      success: false,
      error: 'delay is required',
    });
    expect(await queueManager.getJobState(jobId(id))).toBe('delayed');
  });

  test.each([Number.NaN, 'soon'])(
    'delay %p is rejected with the TCP ChangeDelay message',
    async (delay) => {
      const queueManager = manager();
      const id = await delayed(queueManager);
      const tcp = await handleTcp({ cmd: 'ChangeDelay', id, delay } as never, {
        queueManager,
        authTokens: new Set<string>(),
        authenticated: false,
        clientId: 't',
      });
      expect(tcp.ok).toBe(false);
      const cloud = await handleCloud(queueManager, {
        type: 'command',
        id: 'delay-bad',
        action: 'job:delay',
        jobId: id,
        delay,
      } as never);
      expect(cloud).toEqual({
        type: 'command_result',
        id: 'delay-bad',
        success: false,
        error: (tcp as { error: string }).error,
      });
      expect(await queueManager.getJobState(jobId(id))).toBe('delayed');
    }
  );

  test('a past delay makes the job ready, as TCP ChangeDelay (and 2.9.10) did', async () => {
    const queueManager = manager();
    const id = await delayed(queueManager);
    const result = await handleCloud(queueManager, {
      type: 'command',
      id: 'delay-past',
      action: 'job:delay',
      jobId: id,
      delay: -1,
    });
    expect(result).toMatchObject({ success: true, data: { delayed: true } });
    expect(await queueManager.getJobState(jobId(id))).toBe('waiting');
  });

  test('a valid delay still applies (0 makes the job ready)', async () => {
    const queueManager = manager();
    const id = await delayed(queueManager);
    const result = await handleCloud(queueManager, {
      type: 'command',
      id: 'delay-ok',
      action: 'job:delay',
      jobId: id,
      delay: 0,
    });
    expect(result).toMatchObject({ success: true, data: { delayed: true } });
    expect(await queueManager.getJobState(jobId(id))).toBe('waiting');
  });
});

describe('job:clearLogs validates keepLogs before any adapter runs', () => {
  async function withLogs(queueManager: QueueManager) {
    const job = await queueManager.push('cloud-logs', { data: { n: 1 } });
    for (let i = 0; i < 5; i++) queueManager.addLog(job.id, `line ${i}`);
    return job.id;
  }

  test.each([
    [Number.NaN, 'keepLogs must be a number'],
    ['two', 'keepLogs must be a number'],
  ])('keepLogs %p is rejected and every log is kept', async (keepLogs, message) => {
    const queueManager = manager();
    const id = await withLogs(queueManager);
    const result = await handleCloud(queueManager, {
      type: 'command',
      id: 'logs-bad',
      action: 'job:clearLogs',
      jobId: String(id),
      keepLogs,
    } as never);
    expect(result).toEqual({
      type: 'command_result',
      id: 'logs-bad',
      success: false,
      error: message,
    });
    expect(queueManager.getLogs(id)).toHaveLength(5);
  });

  test('valid values keep their meaning: 2 keeps the last two, 0 or none clears all', async () => {
    const queueManager = manager();
    const id = await withLogs(queueManager);
    const run = (keepLogs?: number) =>
      handleCloud(queueManager, {
        type: 'command',
        id: 'logs-ok',
        action: 'job:clearLogs',
        jobId: String(id),
        ...(keepLogs === undefined ? {} : { keepLogs }),
      });
    expect(await run(1_000_001)).toMatchObject({ success: true });
    expect(queueManager.getLogs(id)).toHaveLength(5);
    expect(await run(3.9)).toMatchObject({ success: true });
    expect(queueManager.getLogs(id)).toHaveLength(3);
    expect(await run(2)).toMatchObject({ success: true });
    expect(queueManager.getLogs(id).map((entry) => entry.message)).toEqual(['line 3', 'line 4']);
    expect(await run(-1)).toMatchObject({ success: true });
    expect(queueManager.getLogs(id)).toHaveLength(0);
  });

  test('the PostgreSQL path (an adapter that bypasses QueueManager.clearLogs) is guarded too', async () => {
    const calls: unknown[] = [];
    const adapter = {
      clearLogs: async (_id: unknown, keepLogs?: number) => {
        calls.push(keepLogs);
      },
    } as unknown as CloudQueueAdapter;
    const handler = JOB_COMMANDS['job:clearLogs']!;
    await expect(
      handler(adapter, {
        type: 'command',
        id: 'x',
        action: 'job:clearLogs',
        jobId: '1',
        keepLogs: Number.NaN,
      })
    ).rejects.toThrow('keepLogs must be a number');
    expect(calls).toEqual([]);
  });
});
