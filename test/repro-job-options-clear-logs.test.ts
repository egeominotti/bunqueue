/**
 * Repro: `clearLogs(keepLogs)` did not validate `keepLogs`, and TCP clients ignored it.
 *
 * - The engine treated NaN as "keep everything" (`logs.length > NaN` is false) and a
 *   negative value as "clear everything", and trimmed a fraction with `slice(-2.5)`.
 * - Every TCP client path (`Queue.clearJobLogs`, Queue and Worker job objects) ignored
 *   the `ClearLogs` reply, so a rejection was silent over TCP.
 * - The Job returned by `Queue.add` over TCP dropped the `keepLogs` argument entirely,
 *   so `job.clearLogs(1)` cleared every entry while embedded mode kept one.
 *
 * `keepLogs` is now refused only when it is not a number (NaN, text), with the same
 * message in both modes. Every number keeps 2.9.10's result (0 or less clears all, a
 * fraction keeps its whole part, a count above the entries keeps them all):
 * repro-compat-job-wire.test.ts and repro-compat-job-commands.test.ts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { CoreE2eHarness, type CoreE2eMode } from './core-e2e/support/harness';

let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    return `value: ${String(await promise)}`;
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const INVALID: ReadonlyArray<readonly [number, string]> = [
  [Number.NaN, 'error: keepLogs must be a number'],
  ['abc' as unknown as number, 'error: keepLogs must be a number'],
];

describe.each(['embedded', 'tcp'] as const)('clearLogs keepLogs (%s)', (mode: CoreE2eMode) => {
  test('Queue.clearJobLogs and job.clearLogs reject an invalid keepLogs', async () => {
    harness = await CoreE2eHarness.start(mode, 'clear-logs-queue');
    const queue = harness.queue('clear-logs-queue');
    const job = await queue.add('task', {});
    for (const line of ['a', 'b', 'c']) await queue.addJobLog(job.id, line);

    const mismatches: string[] = [];
    for (const [keepLogs, message] of INVALID) {
      const viaQueue = await outcome(queue.clearJobLogs(job.id, keepLogs));
      const viaJob = await outcome(job.clearLogs(keepLogs));
      if (viaQueue !== message) mismatches.push(`queue ${keepLogs}: ${viaQueue}`);
      if (viaJob !== message) mismatches.push(`job ${keepLogs}: ${viaJob}`);
    }
    expect(mismatches).toEqual([]);
    expect((await queue.getJobLogs(job.id)).count).toBe(3);
  });

  test('job.clearLogs(keepLogs) keeps the most recent entries', async () => {
    harness = await CoreE2eHarness.start(mode, 'clear-logs-keep');
    const queue = harness.queue('clear-logs-keep');
    const job = await queue.add('task', {});
    for (const line of ['a', 'b', 'c']) await queue.addJobLog(job.id, line);
    await job.clearLogs(1);
    const { logs } = await queue.getJobLogs(job.id);
    expect(logs.map((entry) => String(entry))).toEqual(['[info] c']);
  });

  test('a Worker job rejects an invalid keepLogs', async () => {
    harness = await CoreE2eHarness.start(mode, 'clear-logs-worker');
    const queue = harness.queue('clear-logs-worker');
    await queue.add('task', {});
    const result = await new Promise<string>((resolve) => {
      harness!.worker(queue.name, async (job) => {
        await job.log('kept');
        resolve(await outcome(job.clearLogs(Number.NaN)));
        return 'done';
      });
    });
    expect(result).toBe('error: keepLogs must be a number');
  });
});
