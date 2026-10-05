/**
 * Repro (real worker threads, real broker): progress reported from a sandbox thread.
 *
 * The sandboxed queue operations forwarded the thread's value as-is, so BullMQ-style
 * object progress, which every other job object maps to progress 0 plus the object's
 * JSON as the message, was stored as NaN. Every value now goes through the shared
 * `progressUpdate` (`normalizeProgress`), which never fails the job: a numeric string is
 * its number and other text is 0 with the text as the message, as on every other path.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobId } from '../src/domain/types/job';
import { SandboxedWorker } from '../src/client/sandboxed';
import {
  type CoreE2eHarness,
  MODES,
  closeHarness,
  startHarness,
  waitForState,
  waitUntil,
} from './docs-guide-support';

type ReportedError = Error & { context?: string; jobId?: string };

let harness: CoreE2eHarness | null = null;
let worker: SandboxedWorker | null = null;

afterEach(async () => {
  await worker?.stop(true).catch(() => undefined);
  worker = null;
  await closeHarness(harness);
  harness = null;
});

/** A processor that reports `job.data.progress`, then holds the job for a moment. */
function reportingProcessor(active: CoreE2eHarness): string {
  const path = join(active.dataDir, 'progress-processor.ts');
  writeFileSync(
    path,
    `export default async (job: { data: { progress: unknown }; progress: (value: unknown) => void }) => {
  job.progress(job.data.progress);
  await Bun.sleep(400);
  return 'done';
};\n`
  );
  return path;
}

function startWorker(active: CoreE2eHarness, queue: string) {
  const errors: ReportedError[] = [];
  const events: unknown[] = [];
  const created = new SandboxedWorker(queue, {
    processor: reportingProcessor(active),
    ...(active.mode === 'tcp' ? { connection: active.connection() } : {}),
  });
  created.on('error', (error) => errors.push(error));
  created.on('progress', (_job, progress) => events.push(progress));
  worker = created;
  return { created, errors, events };
}

for (const mode of MODES) {
  describe(`SandboxedWorker progress from the thread [${mode}]`, () => {
    test('object progress is stored as 0 with its JSON as the message', async () => {
      harness = await startHarness('sandboxed-progress', mode);
      const queue = harness.queue<{ progress: unknown }>('jobs');
      const { created, errors, events } = startWorker(harness, queue.name);
      await created.start();

      const stage = { stage: 'resize', pct: 40 };
      const job = await queue.add('report', { progress: stage }, { durable: true });
      const broker = harness.brokerManager();
      await waitUntil(
        () => broker.getProgress(jobId(job.id))?.message === JSON.stringify(stage),
        'the progress message'
      );
      expect(broker.getProgress(jobId(job.id))).toEqual({
        progress: 0,
        message: '{"stage":"resize","pct":40}',
      });
      await waitForState(queue, job.id, 'completed', 5_000);
      expect(events).toEqual([stage]);
      expect(errors).toEqual([]);
    }, 30_000);

    test('a number is stored as the progress, as before', async () => {
      harness = await startHarness('sandboxed-progress-number', mode);
      const queue = harness.queue<{ progress: unknown }>('jobs');
      const { created, errors } = startWorker(harness, queue.name);
      await created.start();

      const job = await queue.add('report', { progress: 65 }, { durable: true });
      const broker = harness.brokerManager();
      await waitUntil(() => broker.getProgress(jobId(job.id))?.progress === 65, 'progress 65');
      await waitForState(queue, job.id, 'completed', 5_000);
      expect(errors).toEqual([]);
    }, 30_000);

    test('text progress is stored as 0 with the text as the message, without an error', async () => {
      harness = await startHarness('sandboxed-progress-text', mode);
      const queue = harness.queue<{ progress: unknown }>('jobs');
      const { created, errors } = startWorker(harness, queue.name);
      await created.start();

      const job = await queue.add('report', { progress: 'half' }, { durable: true });
      const broker = harness.brokerManager();
      await waitUntil(() => broker.getProgress(jobId(job.id))?.message === 'half', 'the message');
      expect(broker.getProgress(jobId(job.id))).toEqual({ progress: 0, message: 'half' });
      await waitForState(queue, job.id, 'completed', 5_000);
      expect(errors).toEqual([]);
    }, 30_000);
  });
}
