/**
 * Repro: job-object duration methods behave differently in embedded and TCP mode.
 *
 * The Worker processor job (also used by sandboxed jobs), FlowProducer jobs and DLQ
 * jobs each implement `extendLock`, `changeDelay` and `moveToDelayed`:
 *
 * - a Worker job's TCP `extendLock(token, NaN)` resolved 0 (the broker's validation
 *   error was swallowed), while embedded mode threw;
 * - a flow or DLQ job's TCP `extendLock` with a missing lease threw
 *   `Lock not found or invalid token`, while embedded mode (and BullMQ) resolve 0;
 * - `moveToDelayed(NaN)` reported `delay must be a finite number` although the caller
 *   passed a timestamp, and `moveToDelayed(-Infinity)` was accepted as "now".
 *
 * Every path now checks its argument with the broker's validators before sending, a
 * missing or mismatched lease resolves 0 in both modes, and any other broker
 * rejection throws.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { UnrecoverableError, type Job } from '../src/client';
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

async function durationOutcomes(job: Job<unknown>, token: string | undefined) {
  return {
    extendNaN: await outcome(job.extendLock(token ?? 'none', Number.NaN)),
    extendMissingLease: await outcome(job.extendLock('wrong-token', 30_000)),
    changeDelayNaN: await outcome(job.changeDelay(Number.NaN)),
    moveToDelayedNaN: await outcome(job.moveToDelayed(Number.NaN, token)),
    moveToDelayedMinusInfinity: await outcome(job.moveToDelayed(-Infinity, token)),
  };
}

const EXPECTED = {
  extendNaN: 'error: duration must be a finite number',
  extendMissingLease: 'value: 0',
  changeDelayNaN: 'error: delay must be a finite number',
  moveToDelayedNaN: 'error: timestamp must be a finite number',
  moveToDelayedMinusInfinity: 'error: timestamp must be a finite number',
};

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error('condition not reached');
}

describe.each(['embedded', 'tcp'] as const)('job duration methods (%s)', (mode: CoreE2eMode) => {
  test('a Worker processor job validates and reports like the broker', async () => {
    harness = await CoreE2eHarness.start(mode, 'job-methods-worker');
    const queue = harness.queue('job-methods-worker');
    await queue.add('task', {});
    const outcomes = await new Promise<Record<string, string>>((resolve) => {
      harness!.worker(queue.name, async (job) => {
        resolve(await durationOutcomes(job, job.token));
        return 'done';
      });
    });
    expect(outcomes).toEqual(EXPECTED);
  });

  test('a FlowProducer job validates and reports like the broker', async () => {
    harness = await CoreE2eHarness.start(mode, 'job-methods-flow');
    const queue = harness.queue('job-methods-flow');
    const node = await harness.flow().add({ name: 'solo', queueName: queue.name, data: {} });
    expect(await durationOutcomes(node.job as Job<unknown>, undefined)).toEqual(EXPECTED);
  });

  test('a DLQ job validates and reports like the broker', async () => {
    harness = await CoreE2eHarness.start(mode, 'job-methods-dlq');
    const queue = harness.queue('job-methods-dlq');
    await queue.add('task', {}, { attempts: 1 });
    harness.worker(queue.name, () => {
      throw new UnrecoverableError('to the DLQ');
    });
    const entry = await until(async () => (await queue.getDlqAsync())[0]);
    const outcomes = await durationOutcomes(entry.job as Job<unknown>, undefined);
    expect({
      extendNaN: outcomes.extendNaN,
      extendMissingLease: outcomes.extendMissingLease,
    }).toEqual({ extendNaN: EXPECTED.extendNaN, extendMissingLease: EXPECTED.extendMissingLease });
  });
});
