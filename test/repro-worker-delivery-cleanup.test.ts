import { expect, test } from 'bun:test';
import { jobId } from '../src/domain/types/job';
import {
  FAST_STALL_SWEEP,
  MODES,
  startHarness,
  waitForState,
  waitUntil,
} from './docs-guide-support';

for (const mode of MODES) {
  test(`graceful close renews the lease until the broker accepts the ACK [${mode}]`, async () => {
    const harness = await startHarness('close-during-ack', mode);
    const releaseAck = Promise.withResolvers<void>();
    try {
      const queue = harness.queue('close-during-ack');
      const manager = harness.brokerManager();
      let accepting = false;
      const holdAck = () => {
        accepting = true;
        return releaseAck.promise;
      };
      if (mode === 'embedded') {
        const ack = manager.ack.bind(manager);
        manager.ack = async (...args) => {
          await holdAck();
          return ack(...args);
        };
      } else {
        const ack = manager.ackBatchWithResults.bind(manager);
        manager.ackBatchWithResults = async (...args) => {
          await holdAck();
          return ack(...args);
        };
      }
      const worker = harness.worker(queue.name, () => 'accepted', { heartbeatInterval: 20 });
      const job = await queue.add('subject', {}, { durable: true });
      await waitUntil(() => accepting, 'the broker to receive the terminal ACK');
      const renewals = () => manager.getLockInfo(jobId(job.id))?.renewalCount ?? 0;
      const before = renewals();
      const closing = worker.close();
      await waitUntil(() => renewals() >= before + 2, 'two renewals with the ACK pending', 1500);
      expect(await queue.getJobState(job.id)).toBe('active');
      releaseAck.resolve();
      await closing;
      expect((await queue.getJob(job.id))?.returnvalue).toBe('accepted');
    } finally {
      releaseAck.resolve();
      await harness.close();
    }
  });

  test(`a manual pull crossing close returns its unstarted lease to waiting [${mode}]`, async () => {
    const harness = await startHarness('close-manual-pull', mode);
    try {
      const queue = harness.queue('close-manual-pull');
      const worker = harness.worker(queue.name, () => true, { autorun: false });
      const subject = await queue.add('subject', {}, { attempts: 1, durable: true });
      const control = await queue.add('control', {}, { attempts: 1, durable: true });
      harness.addCleanup(
        harness.brokerManager().subscribe((event) => {
          if (event.eventType === 'pulled' && event.jobId === subject.id) void worker.close();
        })
      );
      const delivered = await worker.getNextJob();
      const duringClose = await worker.getNextJob();
      await worker.close();
      const counts = await queue.getJobCountsAsync();
      expect([delivered?.id, duringClose?.id]).toEqual([undefined, undefined]);
      expect(await queue.getJobState(subject.id)).toBe('waiting');
      expect(await queue.getJobState(control.id)).toBe('waiting');
      expect([counts.waiting, counts.active]).toEqual([2, 0]);
    } finally {
      await harness.close();
    }
  });

  test(`forced close abandons a processor already draining gracefully [${mode}]`, async () => {
    const harness = await startHarness('close-escalation', mode, FAST_STALL_SWEEP);
    const finish = Promise.withResolvers<void>();
    try {
      const queue = harness.queue('close-escalation');
      let started = false;
      let returned = false;
      const outcomes: string[] = [];
      const worker = harness.worker(
        queue.name,
        async () => {
          started = true;
          await finish.promise;
          returned = true;
          return 'old result';
        },
        { lockDuration: 400, heartbeatInterval: 20 }
      );
      worker.on('completed', () => outcomes.push('completed'));
      worker.on('failed', () => outcomes.push('failed'));
      worker.on('error', (error) => outcomes.push(error.message));
      const job = await queue.add('subject', {}, { attempts: 3, durable: true });
      await waitUntil(() => started, 'the first processor to start');
      const renewals = () => harness.brokerManager().getLockInfo(jobId(job.id))?.renewalCount ?? 0;
      const before = renewals();
      const closing = worker.close();
      await waitUntil(() => renewals() > before, 'lease renewal during graceful close', 1500);
      await Promise.all([closing, worker.close(true)]);
      expect(returned).toBe(false);

      harness.worker(queue.name, () => 'replacement result');
      await waitForState(queue, job.id, 'completed');
      finish.resolve();
      await waitUntil(() => returned, 'the abandoned processor to return');
      expect((await queue.getJob(job.id))?.returnvalue).toBe('replacement result');
      expect(outcomes).toEqual([]);
    } finally {
      finish.resolve();
      await harness.close();
    }
  });

  test(`close returns both a buffered job and an in-flight batch refill [${mode}]`, async () => {
    const harness = await startHarness('close-batch-refill', mode);
    try {
      const queue = harness.queue('close-batch-refill');
      const first = await queue.add('buffered', {}, { attempts: 1, durable: true });
      const released: string[] = [];
      let runs = 0;
      const worker = harness.worker(queue.name, () => ++runs, {
        autorun: false,
        batch: { size: 2, minSize: 2 },
        heartbeatInterval: 20,
      });
      const manager = harness.brokerManager();
      harness.addCleanup(
        manager.subscribe((event) => {
          if (event.queue !== queue.name) return;
          if (String(event.eventType) === 'waiting' && event.prev === 'active')
            released.push(event.jobId);
          if (event.eventType === 'pulled' && event.jobId !== first.id) {
            worker.pause();
            void worker.close();
            worker.resume();
          }
        })
      );
      worker.run();
      await waitUntil(
        () => (manager.getLockInfo(jobId(first.id))?.renewalCount ?? 0) > 0,
        'the worker to hold the first member while waiting for a batch'
      );
      const second = await queue.add('refill', {}, { attempts: 1, durable: true });
      await waitUntil(() => worker.closing !== null, 'close during the refill');
      await worker.closing;
      expect(released.sort()).toEqual([first.id, second.id].sort());
      expect(runs).toBe(0);
      const counts = await queue.getJobCountsAsync();
      expect([counts.waiting, counts.active, counts.failed]).toEqual([2, 0, 0]);
    } finally {
      await harness.close();
    }
  });

  test(`a batch releases each member's group after updating data and failing a member [${mode}]`, async () => {
    const harness = await startHarness('batch-group-release', mode);
    try {
      const queue = harness.queue<{ tenant: string }>('batch-group-release');
      const jobs = await queue.addBulk([
        { name: 'fails', data: { tenant: 'A' }, opts: { attempts: 1 } },
        { name: 'succeeds', data: { tenant: 'B' } },
      ]);
      const batches: string[][] = [];
      harness.worker<{ tenant: string }, boolean>(
        queue.name,
        async (job) => {
          const members = job.getBatch!();
          batches.push(members.map((member) => member.name));
          for (const member of members) {
            if (member.name === 'fails') {
              await member.updateData({ tenant: 'B' });
              member.setAsFailed!(new Error('expected failure'));
            }
            if (member.name === 'succeeds') await member.updateData({ tenant: 'C' });
          }
          return true;
        },
        { batch: { size: 2 }, limiter: { groupKey: 'tenant', max: 1, duration: 1000 } }
      );
      await waitForState(queue, jobs[0].id, 'failed');
      await waitForState(queue, jobs[1].id, 'completed');
      const next = await queue.addBulk([
        { name: 'next A', data: { tenant: 'A' } },
        { name: 'control', data: { tenant: 'D' } },
      ]);
      await waitForState(queue, next[1].id, 'completed');
      expect(batches).toEqual([
        ['fails', 'succeeds'],
        ['next A', 'control'],
      ]);
      expect(await queue.getJobState(next[0].id)).toBe('completed');
    } finally {
      await harness.close();
    }
  });

  test(`a retired processor releases its original group while its redelivery is active [${mode}]`, async () => {
    const harness = await startHarness('redelivered-group', mode);
    const old = Promise.withResolvers<void>();
    const current = Promise.withResolvers<void>();
    try {
      const queue = harness.queue<{ tenant: string }>('redelivered-group');
      let generations = 0;
      const probes: string[] = [];
      harness.worker<{ tenant: string }, string>(
        queue.name,
        async (job) => {
          if (job.name === 'subject') {
            if (++generations === 1) {
              await job.updateData({ tenant: 'B' });
              await job.moveToWait(job.token);
              await old.promise;
              throw new Error('retired generation');
            }
            await current.promise;
          } else {
            probes.push(job.name);
          }
          return job.name;
        },
        { concurrency: 2, batchSize: 1, limiter: { groupKey: 'tenant', max: 1, duration: 1000 } }
      );
      const job = await queue.add('subject', { tenant: 'A' }, { durable: true });
      await waitUntil(() => generations === 2, 'redelivery to run under group B');
      const [nextB, nextA, control] = await queue.addBulk([
        { name: 'next B', data: { tenant: 'B' } },
        { name: 'next A', data: { tenant: 'A' } },
        { name: 'control', data: { tenant: 'C' } },
      ]);
      old.resolve();
      await waitForState(queue, control.id, 'completed');
      expect(probes).toEqual(['next A', 'control']);
      expect(await queue.getJobState(nextA.id)).toBe('completed');
      current.resolve();
      await waitForState(queue, nextB.id, 'completed');
      expect((await queue.getJob(job.id))?.returnvalue).toBe('subject');
      expect(probes).toEqual(['next A', 'control', 'next B']);
    } finally {
      old.resolve();
      current.resolve();
      await harness.close();
    }
  }, 10_000);
}
