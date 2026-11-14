import { Queue, Worker } from '../../src/client';
import { CoreE2eHarness } from '../../test/core-e2e/support/harness';
import { cleanupAll, eventually } from './maintenance-contract-support';

export async function runAdvancedDlqAutoRetryContract(mode: 'embedded' | 'tcp') {
  const harness = await CoreE2eHarness.start(mode, 'dlq-auto-retry', { dlqMaintenanceMs: 100 });
  const queueName = harness.unique('auto-retry');
  const queue = new Queue<{ value: number }>(queueName, harness.queueOptions());
  let worker: Worker<{ value: number }> | undefined;
  let passed = 0;
  let failed = 0;
  const check = (condition: boolean, label: string, detail: string): void => {
    console.log(`   [${condition ? 'PASS' : 'FAIL'}] ${label}${condition ? '' : `: ${detail}`}`);
    if (condition) passed++;
    else failed++;
  };
  console.log('\n6. The background task performs one bounded automatic retry...');
  try {
    await queue.setDlqConfigAsync({
      autoRetry: true,
      autoRetryInterval: 1,
      maxAutoRetries: 1,
      maxAge: null,
    });
    const job = await queue.add('auto-retry', { value: 51 }, { attempts: 1, backoff: 0 });
    let processingAttempts = 0;
    worker = new Worker(
      queueName,
      () => {
        processingAttempts++;
        throw new Error(`automatic-failure-${processingAttempts}`);
      },
      harness.workerOptions({ concurrency: 1 })
    );
    worker.on('error', () => undefined);
    await worker.waitUntilReady();
    const read = async () => ({ processingAttempts, entries: await queue.getDlqAsync() });
    let automatic = await eventually(
      read,
      (current) =>
        current.processingAttempts === 2 &&
        current.entries.length === 1 &&
        current.entries[0]?.retryCount === 1
    );
    const exhausted = (current: typeof automatic): boolean =>
      current.processingAttempts === 2 &&
      current.entries.length === 1 &&
      current.entries[0]?.job.id === job.id &&
      current.entries[0]?.retryCount === 1 &&
      current.entries[0]?.nextRetryAt === null &&
      current.entries[0]?.attempts.map((attempt) => attempt.error).join(',') ===
        'automatic-failure-1,automatic-failure-2';
    // Keep the worker alive across six configured maintenance periods.
    // Catching the first retry alone cannot prove that the cap is enforced.
    const observationEnd = Date.now() + 650;
    let remainedExhausted = exhausted(automatic);
    while (Date.now() < observationEnd) {
      await Bun.sleep(25);
      automatic = await read();
      remainedExhausted = exhausted(automatic) && remainedExhausted;
    }
    check(
      automatic.processingAttempts === 2,
      'the maintenance loop redelivers the terminal job exactly once',
      String(automatic.processingAttempts)
    );
    check(
      remainedExhausted,
      'the exhausted automatic retry retains its full history and stops',
      JSON.stringify(automatic)
    );
  } catch (error) {
    console.error('   [FAIL] automatic retry contract error:', error);
    failed++;
  } finally {
    try {
      await cleanupAll([
        async () => {
          await worker?.close(true);
        },
        () => queue.obliterateAsync(),
        () => queue.close(),
        () => harness.close(),
      ]);
    } catch (error) {
      console.error('   [FAIL] automatic retry cleanup error:', error);
      failed++;
    }
  }
  return { passed, failed };
}
