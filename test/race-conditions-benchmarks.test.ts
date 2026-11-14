import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { QueueManager } from '../src/application/queueManager';
import { raceConditionsFixture } from './support/race-conditions-fixture';

describe('Race Condition Benchmarks', () => {
  let qm: QueueManager;

  const fixture = raceConditionsFixture();
  beforeEach(async () => {
    qm = await fixture.create();
  });
  afterEach(() => fixture.close());

  test('BENCHMARK: 1000 concurrent push operations', async () => {
    const COUNT = 1000;

    const start = performance.now();
    const pushes = Array.from({ length: COUNT }, (_, i) => qm.push('bench-push', { data: { i } }));
    await Promise.all(pushes);
    const duration = performance.now() - start;

    console.log(`\n📊 1000 concurrent pushes: ${duration.toFixed(2)}ms`);
    console.log(`   Throughput: ${(COUNT / (duration / 1000)).toFixed(0)} ops/sec`);

    const stats = qm.getStats();
    expect(stats.waiting).toBe(COUNT);
  });

  test('BENCHMARK: 500 concurrent pull operations', async () => {
    const COUNT = 500;

    // First push
    for (let i = 0; i < COUNT; i++) {
      await qm.push('bench-pull', { data: { i } });
    }

    const start = performance.now();
    const pulls = Array.from({ length: COUNT }, () => qm.pull('bench-pull', 100));
    const results = await Promise.all(pulls);
    const duration = performance.now() - start;

    const pulled = results.filter((r) => r !== null).length;

    console.log(`\n📊 500 concurrent pulls: ${duration.toFixed(2)}ms`);
    console.log(`   Pulled: ${pulled} jobs`);
    console.log(`   Throughput: ${(pulled / (duration / 1000)).toFixed(0)} ops/sec`);

    expect(pulled).toBe(COUNT);
  });

  test('BENCHMARK: Mixed concurrent operations (push/pull/ack)', async () => {
    const ITERATIONS = 300;

    const start = performance.now();
    const operations: Promise<any>[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      // Push
      operations.push(qm.push('bench-mixed', { data: { i } }));

      // Pull and ack
      operations.push(
        qm.pull('bench-mixed', 50).then(async (job) => {
          if (job) {
            await qm.ack(job.id, {});
            return true;
          }
          return false;
        })
      );
    }

    await Promise.all(operations);
    const duration = performance.now() - start;

    console.log(`\n📊 ${ITERATIONS * 2} mixed operations: ${duration.toFixed(2)}ms`);
    console.log(`   Throughput: ${((ITERATIONS * 2) / (duration / 1000)).toFixed(0)} ops/sec`);

    // Clean up remaining
    while (true) {
      const job = await qm.pull('bench-mixed', 10);
      if (!job) break;
      await qm.ack(job.id, {});
    }

    const stats = qm.getStats();
    expect(stats.waiting).toBe(0);
    expect(stats.active).toBe(0);
  });

  test('BENCHMARK: Client disconnect/release under load', async () => {
    const CLIENTS = 20;
    const JOBS_PER_CLIENT = 50;

    // Setup: push and pull jobs for each client
    for (let c = 0; c < CLIENTS; c++) {
      for (let j = 0; j < JOBS_PER_CLIENT; j++) {
        await qm.push('bench-release', { data: { c, j } });
      }
    }

    for (let c = 0; c < CLIENTS; c++) {
      for (let j = 0; j < JOBS_PER_CLIENT; j++) {
        const job = await qm.pull('bench-release', 0);
        if (job) {
          qm.registerClientJob(`client-${c}`, job.id);
        }
      }
    }

    const start = performance.now();
    const releases = Array.from({ length: CLIENTS }, (_, c) => qm.releaseClientJobs(`client-${c}`));
    const results = await Promise.all(releases);
    const duration = performance.now() - start;

    const totalReleased = results.reduce((a, b) => a + b, 0);

    console.log(`\n📊 ${CLIENTS} concurrent client releases: ${duration.toFixed(2)}ms`);
    console.log(`   Total jobs released: ${totalReleased}`);
    console.log(`   Throughput: ${(totalReleased / (duration / 1000)).toFixed(0)} jobs/sec`);

    expect(totalReleased).toBe(CLIENTS * JOBS_PER_CLIENT);
  });
});
