/**
 * Repro (2.9.10 compatibility): job scheduler templates 2.9.10 ran now throw.
 *
 * `upsertJobScheduler` (and Simple Mode `cron`/`every`, and queue `defaultJobOptions`
 * merged into every template) is usually called at application start. The candidate
 * validated templates with the new PUSH bounds, so a re-upsert at boot threw on
 * templates that 2.9.10 stored and ran: `attempts` 0 or 5000, `timeout`/`stallTimeout`
 * of 25 h, `priority` 2,097,152 or 1.5, `backoff` of 25 h, `delay` of 366 days, `'3'`.
 * Over TCP a 2.9.10 client received null (no scheduler).
 *
 * Every such template must be stored again, and its jobs must carry the normalized
 * values createJob applies to the same options on add.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Bunqueue } from '../src/client';
import { jobId } from '../src/domain/types/job';
import { CoreE2eHarness, type CoreE2eMode } from './core-e2e/support/harness';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let harness: CoreE2eHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const TEMPLATES: Array<[string, Record<string, unknown>]> = [
  ['attempts 0', { attempts: 0 }],
  ['attempts 5000', { attempts: 5000 }],
  ['timeout 25h', { timeout: 25 * HOUR }],
  ['stallTimeout 25h', { stallTimeout: 25 * HOUR }],
  ['priority 2097152', { priority: 2_097_152 }],
  ['priority 1.5', { priority: 1.5 }],
  ['backoff 25h', { backoff: 25 * HOUR }],
  ['delay 366d', { delay: 366 * DAY }],
  ["attempts '3'", { attempts: '3' }],
];

async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    const value = await promise;
    return value ? 'stored' : `returned ${String(value)}`;
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

for (const mode of ['embedded', 'tcp'] as CoreE2eMode[]) {
  describe(`job scheduler templates 2.9.10 stored (${mode})`, () => {
    test('upsertJobScheduler stores every template', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-scheduler');
      const queue = harness.queue('compat-scheduler');
      const results: Record<string, string> = {};
      for (const [label, opts] of TEMPLATES) {
        results[label] = await outcome(
          queue.upsertJobScheduler(`s-${label}`, { every: 60_000 }, { name: 't', data: {}, opts })
        );
      }
      expect(results).toEqual(Object.fromEntries(TEMPLATES.map(([label]) => [label, 'stored'])));
    });

    test('defaultJobOptions merged into a template', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-scheduler-defaults');
      const queue = harness.queue('compat-scheduler-defaults', {
        defaultJobOptions: { stallTimeout: 2 * DAY, attempts: 0, timeout: 25 * HOUR },
      });
      await expect(
        outcome(queue.upsertJobScheduler('s', { pattern: '0 9 * * *' }, { name: 'x' }))
      ).resolves.toBe('stored');
    });

    test('a fired job carries the normalized template values', async () => {
      harness = await CoreE2eHarness.start(mode, 'compat-scheduler-fire');
      const queue = harness.queue('compat-scheduler-fire');
      await queue.upsertJobScheduler(
        'fire',
        { every: 200, immediately: true },
        { name: 'x', data: {}, opts: { attempts: 0, timeout: 25 * HOUR, priority: 1.5 } }
      );
      const manager = harness.brokerManager();
      const deadline = Date.now() + 5_000;
      let job: Awaited<ReturnType<typeof manager.getJob>> = null;
      while (!job && Date.now() < deadline) {
        const [first] = manager.getJobs(queue.name, { state: ['waiting', 'prioritized'] });
        job = first ? await manager.getJob(jobId(String(first.id))) : null;
        if (!job) await Bun.sleep(25);
      }
      expect({
        maxAttempts: job?.maxAttempts,
        timeout: job?.timeout,
        priority: job?.priority,
      }).toEqual({ maxAttempts: 1, timeout: 25 * HOUR, priority: 1.5 });
    });
  });
}

describe('Simple Mode cron/every with a 2.9.10 template', () => {
  test('every() with defaultJobOptions above the candidate bounds', async () => {
    harness = await CoreE2eHarness.start('embedded', 'compat-simple');
    const app = new Bunqueue(harness.unique('compat-simple'), {
      embedded: true,
      dataPath: harness.dataPath,
      processor: async () => 'ok',
      defaultJobOptions: { timeout: 25 * HOUR, attempts: 0 },
    } as never);
    harness.addCleanup(() => app.close());
    await expect(outcome(app.every('ping', 60_000, { type: 'health' }))).resolves.toBe('stored');
  });
});
