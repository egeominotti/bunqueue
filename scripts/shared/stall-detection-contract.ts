import { Queue, Worker } from '../../src/client';
import { CoreE2eHarness } from '../../test/core-e2e/support/harness';
import { cleanupAll, eventually } from './maintenance-contract-support';

type Mode = 'embedded' | 'tcp';
type Payload = { value: number };

interface ContractResult {
  passed: number;
  failed: number;
}

export async function runStallDetectionContract(mode: Mode): Promise<ContractResult> {
  const harness = await CoreE2eHarness.start(mode, 'stall', { stallCheckMs: 100 });
  const queueName = `stall-contract-${mode}-${crypto.randomUUID()}`;
  const queue = new Queue<Payload>(queueName, harness.queueOptions());
  const workers: Worker<Payload, unknown>[] = [];
  const releases: Array<() => void> = [];
  let passed = 0;
  let failed = 0;

  const check = (condition: boolean, label: string, detail = ''): void => {
    if (condition) {
      console.log(`   [PASS] ${label}`);
      passed++;
    } else {
      console.log(`   [FAIL] ${label}${detail ? `: ${detail}` : ''}`);
      failed++;
    }
  };

  const options = (heartbeatInterval: number) =>
    harness.workerOptions({ concurrency: 1, heartbeatInterval, useLocks: true });

  const barrier = (): Promise<void> => new Promise((resolve) => releases.push(resolve));

  const clean = async (): Promise<void> => {
    await queue.obliterateAsync();
    await queue.setStallConfigAsync({
      enabled: true,
      stallInterval: 30_000,
      maxStalls: 3,
      gracePeriod: 5_000,
    });
  };

  console.log(`=== Stall detection contract (${mode}) ===\n`);

  try {
    console.log('1. Configuration is authoritative...');
    await clean();
    await queue.setStallConfigAsync({
      enabled: false,
      stallInterval: 1_234,
      maxStalls: 7,
      gracePeriod: 456,
    });
    const config = await queue.getStallConfigAsync();
    check(
      config.enabled === false &&
        config.stallInterval === 1_234 &&
        config.maxStalls === 7 &&
        config.gracePeriod === 456,
      'set/get stall config round-trips every field',
      JSON.stringify(config)
    );

    console.log('\n2. A missing heartbeat reaches the DLQ at maxStalls...');
    await clean();
    await queue.setStallConfigAsync({
      enabled: true,
      stallInterval: 200,
      maxStalls: 1,
      gracePeriod: 50,
    });
    const terminalJob = await queue.add('terminal-stall', { value: 1 }, { attempts: 10 });
    let terminalStarted = false;
    const terminalRelease = barrier();
    const terminalWorker = new Worker<Payload>(
      queueName,
      async () => {
        terminalStarted = true;
        await terminalRelease;
      },
      options(0)
    );
    workers.push(terminalWorker);
    terminalWorker.on('error', () => undefined);
    const stalledEvents: Array<{ jobId: string; reason: string }> = [];
    terminalWorker.on('stalled', (jobId, reason) => stalledEvents.push({ jobId, reason }));
    await terminalWorker.waitUntilReady();
    const activeState = await eventually(
      () => queue.getJobState(terminalJob.id),
      (state) => state === 'active'
    );
    const stalledEntries = await eventually(
      () => queue.getDlqAsync({ reason: 'stalled' }),
      (entries) => entries.length === 1 && entries[0]?.job.id === terminalJob.id
    );
    await eventually(
      () => stalledEvents,
      (events) =>
        events.some((event) => event.jobId === terminalJob.id && event.reason === 'active')
    );
    const terminalState = await queue.getJobState(terminalJob.id);
    const stats = await queue.getDlqStatsAsync();
    const terminalCounts = await queue.getJobCountsAsync();
    check(
      terminalStarted && activeState === 'active',
      'the worker acquired the job before recovery'
    );
    check(
      stalledEntries.length === 1 &&
        terminalState === 'failed' &&
        terminalCounts.failed === 1 &&
        terminalCounts.active === 0 &&
        terminalCounts.waiting === 0,
      'the first stall reaches the DLQ when maxStalls is one',
      `entries=${stalledEntries.length}, state=${terminalState}`
    );
    check(stats.byReason.stalled === 1, 'DLQ statistics classify the stall');
    check(
      stalledEvents.length === 1 &&
        stalledEvents[0]?.jobId === terminalJob.id &&
        stalledEvents[0]?.reason === 'active',
      'Worker emits the broker stall notification with the exact job id'
    );
    await terminalWorker.close(true);

    console.log('\n3. A recoverable stall is redelivered to another worker...');
    await clean();
    await queue.setStallConfigAsync({
      enabled: true,
      stallInterval: 200,
      maxStalls: 2,
      gracePeriod: 50,
    });
    const recoverableJob = await queue.add('recoverable-stall', { value: 2 }, { attempts: 10 });
    const stuckRelease = barrier();
    const stuckWorker = new Worker<Payload>(queueName, async () => await stuckRelease, options(0));
    workers.push(stuckWorker);
    stuckWorker.on('error', () => undefined);
    const recoveryEvents: string[] = [];
    stuckWorker.on('stalled', (id) => recoveryEvents.push(id));
    await stuckWorker.waitUntilReady();
    await eventually(
      () => queue.getJobState(recoverableJob.id),
      (state) => state === 'active'
    );
    const recoveredWaitingState = await eventually(
      () => queue.getJobState(recoverableJob.id),
      (state) => state === 'waiting' || state === 'prioritized'
    );
    await eventually(
      () => recoveryEvents,
      (ids) => ids.length === 1 && ids[0] === recoverableJob.id
    );
    const waitingCounts = await queue.getJobCountsAsync();
    await stuckWorker.close(true);

    let recoveredCount = 0;
    const completedIds: string[] = [];
    const recoveryWorker = new Worker<Payload>(
      queueName,
      (job) => {
        recoveredCount++;
        return { value: job.data.value };
      },
      options(50)
    );
    workers.push(recoveryWorker);
    recoveryWorker.on('completed', (job) => completedIds.push(job.id));
    recoveryWorker.on('error', () => undefined);
    await recoveryWorker.waitUntilReady();
    const completedState = await eventually(
      () => queue.getJobState(recoverableJob.id),
      (state) => state === 'completed'
    );
    await eventually(
      () => completedIds,
      (ids) => ids.length === 1 && ids[0] === recoverableJob.id
    );
    await recoveryWorker.close();
    const recoveredCounts = await queue.getJobCountsAsync();
    check(
      (recoveredWaitingState === 'waiting' || recoveredWaitingState === 'prioritized') &&
        completedState === 'completed' &&
        recoveredCount === 1 &&
        completedIds.length === 1 &&
        waitingCounts.active === 0 &&
        waitingCounts.waiting === 1 &&
        recoveredCounts.completed === 1 &&
        recoveredCounts.active === 0 &&
        recoveredCounts.waiting === 0 &&
        recoveredCounts.failed === 0,
      'the stalled job is requeued and completed exactly once',
      `waiting=${recoveredWaitingState}, completed=${completedState}, count=${recoveredCount}`
    );
    check((await queue.getDlqAsync()).length === 0, 'a recovered stall does not enter the DLQ');

    console.log('\n4. Heartbeats protect work longer than the stall window...');
    await clean();
    await queue.setStallConfigAsync({
      enabled: true,
      stallInterval: 200,
      maxStalls: 1,
      gracePeriod: 50,
    });
    const heartbeatJob = await queue.add('heartbeat-protected', { value: 3 }, { attempts: 1 });
    let heartbeatAttempts = 0;
    const heartbeatStalls: string[] = [];
    const heartbeatWorker = new Worker<Payload>(
      queueName,
      async (job) => {
        heartbeatAttempts++;
        await Bun.sleep(1_000);
        return { value: job.data.value };
      },
      options(50)
    );
    workers.push(heartbeatWorker);
    heartbeatWorker.on('error', () => undefined);
    heartbeatWorker.on('stalled', (id) => heartbeatStalls.push(id));
    await heartbeatWorker.waitUntilReady();
    const heartbeatState = await eventually(
      () => queue.getJobState(heartbeatJob.id),
      (state) => state === 'completed',
      12_000
    );
    await heartbeatWorker.close();
    const heartbeatCounts = await queue.getJobCountsAsync();
    check(
      heartbeatState === 'completed' &&
        heartbeatAttempts === 1 &&
        heartbeatCounts.completed === 1 &&
        heartbeatCounts.active === 0,
      'a heartbeating long job completes normally'
    );
    check(
      (await queue.getDlqAsync()).length === 0 &&
        heartbeatStalls.length === 0 &&
        heartbeatCounts.failed === 0,
      'heartbeating work is never classified stalled'
    );
  } catch (error) {
    console.error('   [FAIL] unexpected contract error:', error);
    failed++;
  } finally {
    try {
      await cleanupAll([
        () => {
          for (const release of releases) release();
        },
        ...workers.map((worker) => () => worker.close(true)),
        () => queue.obliterateAsync(),
        () => queue.close(),
        () => harness.close(),
      ]);
    } catch (error) {
      console.error('   [FAIL] cleanup error:', error);
      failed++;
    }
  }

  console.log(`\n=== Summary ===\nPassed: ${passed}\nFailed: ${failed}`);
  return { passed, failed };
}
