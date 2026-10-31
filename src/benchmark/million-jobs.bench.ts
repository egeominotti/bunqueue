/**
 * Million Jobs Benchmark
 * Tests full job lifecycle: push -> pull -> ack with registered workers
 * Verifies data integrity at both PULL and COMPLETED event
 *
 * Performance notes:
 * - removeOnComplete: true gives maximum throughput (fire-and-forget)
 * - removeOnComplete: false tracks completed jobs, useful for:
 *   - Job result storage
 *   - Job status queries
 *   - Job dependencies
 *
 * Typical results on Apple M-series (with ackBatchWithResults):
 * - Push rate:    ~800K jobs/sec
 * - Process rate: ~525K jobs/sec (removeOnComplete: true, with results)
 * - Process rate: ~387K jobs/sec (removeOnComplete: false, with results)
 *
 * Key optimizations:
 * - Batch eviction in BoundedSet/BoundedMap (avoids per-item iterator overhead)
 * - Indexed for loops (faster than for-of)
 * - Skip broadcast/deps when no listeners
 * - Array-based job extraction (faster iteration than Map)
 * - ackBatchWithResults for batch ack with individual results
 */

import { QueueManager } from '../application/queueManager';
import { SHARD_COUNT } from '../shared/hash';
import type { Worker } from '../domain/types/worker';
import { EventType } from '../domain/types/queue';

const TOTAL_JOBS = 1_000_000;
const BATCH_SIZE = 5000; // Push batch size
const PULL_BATCH_SIZE = 500; // Pull batch size
const WORKER_COUNT = 16; // Match shard count
const QUEUE_COUNT = 16; // Multiple queues for parallel processing
const SKIP_WORKER_STATS = true;
const REMOVE_ON_COMPLETE = true; // true = max throughput (~525K/s with results), false = track completed (~387K/s with results)

console.log(`
🚀 Million Jobs Benchmark
==========================
Jobs:     ${TOTAL_JOBS.toLocaleString()}
Workers:  ${WORKER_COUNT}
Shards:   ${SHARD_COUNT}
Batch:    ${BATCH_SIZE}
Mode:     ${REMOVE_ON_COMPLETE ? 'fire-and-forget (max throughput)' : 'track completed (with overhead)'}
`);

async function runBenchmark() {
  const qm = new QueueManager();
  const queues = Array.from({ length: QUEUE_COUNT }, (_, i) => `benchmark-queue-${i}`);

  // Phase 0: Register workers (one per queue)
  console.log('👷 Phase 0: Registering workers...');
  const workers: { worker: Worker; queue: string }[] = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    const queue = queues[i % QUEUE_COUNT];
    const worker = qm.workerManager.register(`worker-${i}`, [queue]);
    workers.push({ worker, queue });
  }
  console.log(`✅ Registered ${workers.length} workers for ${QUEUE_COUNT} queues\n`);

  // Stats tracking
  let pushed = 0;
  let completed = 0;
  const startTime = Date.now();

  // Phase 1: Push all jobs (distributed across queues)
  console.log('📤 Phase 1: Pushing jobs...');
  const pushStart = Date.now();

  // Push in parallel to all queues
  const jobsPerQueue = Math.ceil(TOTAL_JOBS / QUEUE_COUNT);

  await Promise.all(
    queues.map(async (queue, qIdx) => {
      const queueJobs =
        qIdx === queues.length - 1 ? TOTAL_JOBS - jobsPerQueue * (QUEUE_COUNT - 1) : jobsPerQueue;

      for (let i = 0; i < queueJobs; i += BATCH_SIZE) {
        const batch = Array.from({ length: Math.min(BATCH_SIZE, queueJobs - i) }, (_, j) => ({
          data: { index: qIdx * jobsPerQueue + i + j },
          removeOnComplete: REMOVE_ON_COMPLETE,
        }));
        await qm.pushBatch(queue, batch);
      }
    })
  );

  pushed = TOTAL_JOBS;
  const pushTime = Date.now() - pushStart;
  const pushRate = Math.round(pushed / (pushTime / 1000));
  console.log(
    `✅ Push complete: ${pushed.toLocaleString()} jobs in ${pushTime}ms (${pushRate.toLocaleString()} jobs/sec)\n`
  );

  // Phase 2: Workers pull and complete jobs
  console.log('👷 Phase 2: Workers processing jobs...');
  const processStart = Date.now();

  // Track data integrity - at PULL time
  const seenAtPull = new Set<number>();
  let pullDataErrors = 0;

  // Track data integrity - at COMPLETED event time
  const seenAtCompleted = new Set<number>();
  let completedDataErrors = 0;

  // Subscribe to completed events to verify data arrives correctly
  const unsubscribe = qm.subscribe((event) => {
    if (event.eventType === EventType.Completed) {
      const data = event.data as { index: number } | undefined;
      if (data && typeof data.index === 'number') {
        seenAtCompleted.add(data.index);
      } else {
        completedDataErrors++;
      }
    }
  });

  // Worker function (each worker processes its assigned queue)
  async function workerLoop(worker: Worker, queue: string): Promise<number> {
    let workerCompleted = 0;

    while (true) {
      // Pull batch of jobs from assigned queue
      const jobs = await qm.pullBatch(queue, PULL_BATCH_SIZE, 0);

      if (jobs.length === 0) {
        break;
      }

      // ✅ Verify job data integrity at PULL time
      for (const job of jobs) {
        const data = job.data as { index: number };
        if (typeof data?.index !== 'number') {
          pullDataErrors++;
        } else if (seenAtPull.has(data.index)) {
          pullDataErrors++; // Duplicate!
        } else {
          seenAtPull.add(data.index);
        }
      }

      // Ack all jobs with their data as result (so completed event receives it)
      // Using batch ack with results for maximum throughput
      const ackItems = jobs.map((job) => ({ id: job.id, result: job.data }));
      await qm.ackBatchWithResults(ackItems);

      // Update worker stats (optional - for overhead comparison)
      if (!SKIP_WORKER_STATS) {
        for (let i = 0; i < jobs.length; i++) {
          qm.workerManager.jobCompleted(worker.id);
        }
      }

      workerCompleted += jobs.length;
    }

    return workerCompleted;
  }

  // Start all workers in parallel (each on its own queue)
  const workerPromises = workers.map((w) => workerLoop(w.worker, w.queue));

  // Progress reporter
  const progressInterval = setInterval(() => {
    const stats = qm.getStats();
    const workerStats = qm.workerManager.getStats();
    const elapsed = (Date.now() - processStart) / 1000;
    const rate = Math.round(workerStats.totalProcessed / elapsed);
    console.log(
      `  Progress: ${workerStats.totalProcessed.toLocaleString()} completed, ` +
        `${stats.waiting.toLocaleString()} waiting, ` +
        `${workerStats.activeJobs} active (${rate.toLocaleString()} jobs/sec)`
    );
  }, 2000);

  // Wait for all workers to complete
  const workerResults = await Promise.all(workerPromises);
  clearInterval(progressInterval);

  completed = workerResults.reduce((a, b) => a + b, 0);

  const processTime = Date.now() - processStart;
  const processRate = Math.round(completed / (processTime / 1000));

  console.log(
    `✅ Process complete: ${completed.toLocaleString()} jobs in ${processTime}ms (${processRate.toLocaleString()} jobs/sec)\n`
  );

  // Summary
  const totalTime = Date.now() - startTime;
  const overallRate = Math.round(TOTAL_JOBS / (totalTime / 1000));

  const finalStats = qm.getStats();
  const workerStats = qm.workerManager.getStats();

  // Unsubscribe from events
  unsubscribe();

  // ✅ Verify all jobs were processed with correct data
  const missingAtPull = [];
  const missingAtCompleted = [];
  for (let i = 0; i < TOTAL_JOBS; i++) {
    if (!seenAtPull.has(i) && missingAtPull.length < 10) missingAtPull.push(i);
    if (!seenAtCompleted.has(i) && missingAtCompleted.length < 10) missingAtCompleted.push(i);
  }

  const pullPassed = seenAtPull.size === TOTAL_JOBS && pullDataErrors === 0;
  const completedPassed = seenAtCompleted.size === TOTAL_JOBS && completedDataErrors === 0;

  console.log(`
📊 Summary
==========================
Total jobs:      ${TOTAL_JOBS.toLocaleString()}
Completed:       ${completed.toLocaleString()}
Total time:      ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)

Push rate:       ${pushRate.toLocaleString()} jobs/sec
Process rate:    ${processRate.toLocaleString()} jobs/sec
Overall rate:    ${overallRate.toLocaleString()} jobs/sec

Workers:         ${WORKER_COUNT}
Per-worker avg:  ${Math.round(completed / WORKER_COUNT).toLocaleString()} jobs

✅ Data Integrity (at PULL)
--------------------------
Unique indexes:  ${seenAtPull.size.toLocaleString()} / ${TOTAL_JOBS.toLocaleString()}
Data errors:     ${pullDataErrors}
Missing indexes: ${missingAtPull.length > 0 ? missingAtPull.join(', ') + '...' : 'none'}
Status:          ${pullPassed ? '✅ PASSED' : '❌ FAILED'}

✅ Data Integrity (at COMPLETED event)
--------------------------
Unique indexes:  ${seenAtCompleted.size.toLocaleString()} / ${TOTAL_JOBS.toLocaleString()}
Data errors:     ${completedDataErrors}
Missing indexes: ${missingAtCompleted.length > 0 ? missingAtCompleted.join(', ') + '...' : 'none'}
Status:          ${completedPassed ? '✅ PASSED' : '❌ FAILED'}

📈 Final Stats
--------------------------
Queue waiting:   ${finalStats.waiting}
Queue active:    ${finalStats.active}
Queue completed: ${finalStats.completed}
Worker processed: ${workerStats.totalProcessed.toLocaleString()}
Worker failed:   ${workerStats.totalFailed}
`);

  // Cleanup: unregister workers
  for (const { worker } of workers) {
    qm.workerManager.unregister(worker.id);
  }

  qm.shutdown();
}

runBenchmark().catch(console.error);
