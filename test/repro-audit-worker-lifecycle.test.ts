import { expect, test } from 'bun:test';
import type { Queue } from '../src/client';
import {
  type CoreE2eHarness,
  FAST_STALL_SWEEP,
  MODES,
  startHarness,
  waitForState,
  waitUntil,
} from './docs-guide-support';

const leaseMs = 400;

// Wait for an actual expiry sweep after the caller's lease began.
async function waitForLeaseExpiry(harness: CoreE2eHarness, queue: Queue): Promise<void> {
  const probe = harness.worker(queue.name, () => true, {
    autorun: false,
    lockDuration: leaseMs,
    heartbeatInterval: 0,
  });
  const witness = await queue.add('expiry witness', {}, { attempts: 1, durable: true });
  expect(String((await probe.getNextJob())?.id)).toBe(witness.id);
  await waitForState(queue, witness.id, 'failed');
}

for (const mode of MODES) {
  test(`graceful Worker.close renews an active job until its result is saved [${mode}]`, async () => {
    const harness = await startHarness('close-active-lease', mode, FAST_STALL_SWEEP);
    const finish = Promise.withResolvers<void>();
    try {
      const queue = harness.queue('close-active-lease');
      const processed: string[] = [];
      const worker = harness.worker(
        queue.name,
        async (job) => {
          processed.push(job.id);
          await finish.promise;
          return 'saved result';
        },
        { lockDuration: leaseMs, heartbeatInterval: 40 }
      );
      const errors: string[] = [];
      worker.on('error', (err) => errors.push(err.message));
      const subject = await queue.add('subject', {}, { attempts: 1, durable: true });
      await waitUntil(() => processed.length === 1, 'the subject processor to start');
      const closing = worker.close();

      await waitForLeaseExpiry(harness, queue);
      finish.resolve();
      await closing;

      const counts = await queue.getJobCountsAsync();
      expect({
        processed,
        state: await queue.getJobState(subject.id),
        result: (await queue.getJob(subject.id))?.returnvalue,
        active: counts.active,
        completed: counts.completed,
        failed: counts.failed,
        errors,
      }).toEqual({
        processed: [subject.id],
        state: 'completed',
        result: 'saved result',
        active: 0,
        completed: 1,
        failed: 1,
        errors: [],
      });
    } finally {
      finish.resolve();
      await harness.close();
    }
  }, 10_000);

  test(`pausing during a pull preserves the delivery for resume [${mode}]`, async () => {
    const harness = await startHarness('pause-pull', mode, FAST_STALL_SWEEP);
    try {
      const queue = harness.queue('pause-pull');
      const processed: string[] = [];
      const worker = harness.worker(
        queue.name,
        (job) => {
          processed.push(job.name);
          return job.name;
        },
        { autorun: false, lockDuration: leaseMs, heartbeatInterval: 40 }
      );
      const options = { attempts: 1, durable: true };
      const control = await queue.add('resume control', {}, options);
      const subject = await queue.add('pause subject', {}, options);

      // The broker emits "pulled" before returning the delivery to the worker.
      // Apply each control at that same boundary without racing wall-clock sleeps.
      let pauseIssued = false;
      const unsubscribe = harness.brokerManager().subscribe((event) => {
        if (event.eventType !== 'pulled') return;
        if (event.jobId === control.id) worker.resume();
        if (event.jobId === subject.id && !pauseIssued) {
          pauseIssued = true;
          worker.pause();
        }
      });
      harness.addCleanup(unsubscribe);
      worker.run();
      await waitUntil(() => pauseIssued, 'pause at the subject pull');
      expect(await queue.getJobState(control.id)).toBe('completed');
      await waitForLeaseExpiry(harness, harness.queue('pause-witness'));
      const failedBeforeResume = (await queue.getJobState(subject.id)) === 'failed';
      expect(processed).toEqual(['resume control']);

      const afterResume = await queue.add('after resume', {}, options);
      worker.resume();
      await waitForState(queue, afterResume.id, 'completed');
      const counts = await queue.getJobCountsAsync();
      expect({
        failedBeforeResume,
        processed,
        state: await queue.getJobState(subject.id),
        result: (await queue.getJob(subject.id))?.returnvalue,
        completed: counts.completed,
        failed: counts.failed,
      }).toEqual({
        failedBeforeResume: false,
        processed: ['resume control', 'pause subject', 'after resume'],
        state: 'completed',
        result: 'pause subject',
        completed: 3,
        failed: 0,
      });
    } finally {
      await harness.close();
    }
  }, 10_000);

  test(`updating job data releases its original worker group slot [${mode}]`, async () => {
    const harness = await startHarness('group-slot-update', mode);
    try {
      const queue = harness.queue<{ tenant: string }>('group-slot-update');
      const seen: string[] = [];
      harness.worker<{ tenant: string }, string>(
        queue.name,
        async (job) => {
          seen.push(job.name);
          if (job.name === 'first') await job.updateData({ tenant: 'B' });
          return job.name;
        },
        { concurrency: 1, limiter: { groupKey: 'tenant', max: 1, duration: 1000 } }
      );
      const first = await queue.add('first', { tenant: 'A' }, { durable: true });
      await waitForState(queue, first.id, 'completed');
      const [next, control] = await queue.addBulk([
        { name: 'second A', data: { tenant: 'A' } },
        { name: 'other tenant', data: { tenant: 'C' } },
      ]);
      await waitForState(queue, control.id, 'completed');

      // The single worker has processed a later FIFO job. It should also have
      // processed the earlier A job, since the first A processor finished.
      const counts = await queue.getJobCountsAsync();
      expect({
        seen,
        state: await queue.getJobState(next.id),
        result: (await queue.getJob(next.id))?.returnvalue,
        active: counts.active,
        completed: counts.completed,
      }).toEqual({
        seen: ['first', 'second A', 'other tenant'],
        state: 'completed',
        result: 'second A',
        active: 0,
        completed: 3,
      });
    } finally {
      await harness.close();
    }
  }, 10_000);
}
