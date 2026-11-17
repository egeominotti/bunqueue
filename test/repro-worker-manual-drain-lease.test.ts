import { expect, test } from 'bun:test';
import { FAST_STALL_SWEEP, MODES, startHarness, waitForState } from './docs-guide-support';

const leaseMs = 250;
const cases = [
  { name: 'enabled', options: { heartbeatInterval: 20 }, renews: true },
  { name: 'zero interval', options: { heartbeatInterval: 0 }, renews: false },
  {
    name: 'skipLockRenewal',
    options: { heartbeatInterval: 20, skipLockRenewal: true },
    renews: false,
  },
];

for (const mode of MODES) {
  test(`a manual processor renews only the deliveries being processed [${mode}]`, async () => {
    const harness = await startHarness('manual-claim-renewal', mode, FAST_STALL_SWEEP);
    const finish = Promise.withResolvers<void>();
    try {
      const queue = harness.queue('manual-claim-renewal');
      const worker = harness.worker(
        queue.name,
        async () => {
          await finish.promise;
          return 'finished';
        },
        { autorun: false, lockDuration: leaseMs, heartbeatInterval: 20 }
      );
      const first = await queue.add('processing', {}, { attempts: 1, durable: true });
      const second = await queue.add('held', {}, { attempts: 1, durable: true });
      const active = await worker.getNextJob();
      const held = await worker.getNextJob();
      expect(String(active?.id)).toBe(first.id);
      expect(String(held?.id)).toBe(second.id);
      if (!active) throw new Error('Expected the first manual delivery');
      const processing = worker.processJobManually(active);
      await waitForState(queue, second.id, 'failed');
      expect(await queue.getJobState(first.id)).toBe('active');
      finish.resolve();
      await processing;
      expect((await queue.getJob(first.id))?.returnvalue).toBe('finished');
    } finally {
      finish.resolve();
      await harness.close();
    }
  });

  for (const { name, options, renews } of cases) {
    test(`manual processing honors lease renewal during graceful close [${mode}, ${name}]`, async () => {
      const harness = await startHarness('manual-drain-lease', mode, FAST_STALL_SWEEP);
      const finish = Promise.withResolvers<void>();
      try {
        const queue = harness.queue('manual-drain');
        const started = Promise.withResolvers<void>();
        const processed: string[] = [];
        const errors: string[] = [];
        const worker = harness.worker(
          queue.name,
          async (job) => {
            processed.push(job.id);
            started.resolve();
            await finish.promise;
            return 'manual result';
          },
          { autorun: false, lockDuration: leaseMs, ...options }
        );
        worker.on('error', (error) => errors.push(error.message));
        const subject = await queue.add('subject', {}, { attempts: 1, durable: true });
        const waiting = await queue.add('waiting', {}, { attempts: 1, durable: true });
        const manual = await worker.getNextJob();
        expect(String(manual?.id)).toBe(subject.id);
        if (!manual) throw new Error('Expected the manual delivery');
        const processing = worker.processJobManually(manual);
        await started.promise;
        expect(worker.isRunning()).toBe(false);
        const closing = worker.close();

        // This lease starts after the subject's. Its expiry proves a real
        // broker sweep took place while the manual processor was draining.
        const witnessQueue = harness.queue('expiry-witness');
        const probe = harness.worker(witnessQueue.name, () => true, {
          autorun: false,
          lockDuration: leaseMs,
          heartbeatInterval: 0,
        });
        const witness = await witnessQueue.add('witness', {}, { attempts: 1, durable: true });
        expect(String((await probe.getNextJob())?.id)).toBe(witness.id);
        await waitForState(witnessQueue, witness.id, 'failed');
        const afterSweep = await queue.getJobState(subject.id);
        if (!renews) await worker.close(true);
        finish.resolve();
        await Promise.all([processing, closing]);

        const counts = await queue.getJobCountsAsync();
        expect({
          afterSweep,
          processed,
          errors,
          result: (await queue.getJob(subject.id))?.returnvalue,
          waiting: await queue.getJobState(waiting.id),
          counts: [counts.waiting, counts.active, counts.completed, counts.failed],
        }).toEqual({
          afterSweep: renews ? 'active' : 'failed',
          processed: [subject.id],
          errors: [],
          result: renews ? 'manual result' : undefined,
          waiting: 'waiting',
          counts: renews ? [1, 0, 1, 0] : [1, 0, 0, 1],
        });
      } finally {
        finish.resolve();
        await harness.close();
      }
    }, 10_000);
  }
}
