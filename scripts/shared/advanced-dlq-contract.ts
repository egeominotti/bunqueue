import { Queue, Worker } from '../../src/client';
import type { DlqEntry, FailureReason } from '../../src/client/types';
import { CoreE2eHarness } from '../../test/core-e2e/support/harness';
import { runAdvancedDlqAutoRetryContract } from './advanced-dlq-auto-retry-contract';
import { cleanupAll, eventually } from './maintenance-contract-support';

type Mode = 'embedded' | 'tcp';
type Payload = { value: number };

interface ContractResult {
  passed: number;
  failed: number;
}

const FAILURE_REASON = 'max_attempts_exceeded' as FailureReason;

export async function runAdvancedDlqContract(mode: Mode): Promise<ContractResult> {
  const harness = await CoreE2eHarness.start(mode, 'advanced-dlq-manual');
  const queueName = `advanced-dlq-${mode}-${crypto.randomUUID()}`;
  const queue = new Queue<Payload>(queueName, {
    ...harness.queueOptions(),
    defaultJobOptions: { attempts: 1, backoff: 0 },
  });
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

  const clean = async (): Promise<void> => {
    await queue.obliterateAsync();
    await queue.setDlqConfigAsync({
      autoRetry: false,
      autoRetryInterval: 60_000,
      maxAutoRetries: 3,
      maxAge: null,
      maxEntries: 100,
    });
  };

  const failJobs = async (
    values: number[],
    attempts = 1,
    expectedEntries = values.length,
    retainedValues?: number[]
  ): Promise<{ processed: number; entries: DlqEntry<Payload>[] }> => {
    for (const value of values) {
      await queue.add('fail', { value }, { attempts, backoff: 0 });
    }

    let processed = 0;
    const worker = new Worker<Payload>(
      queueName,
      () => {
        processed++;
        throw new Error(`failure-${processed}`);
      },
      harness.workerOptions({ concurrency: 1 })
    );
    worker.on('error', () => undefined);

    try {
      await worker.waitUntilReady();
      await eventually(
        () => processed,
        (count) => count === values.length * attempts
      );
      const entries = await eventually(
        () => queue.getDlqAsync(),
        (current) =>
          current.length === expectedEntries &&
          (retainedValues === undefined ||
            current.map((entry) => entry.job.data.value).join(',') === retainedValues.join(','))
      );
      return { processed, entries };
    } finally {
      await worker.close(true);
    }
  };

  console.log(`=== Advanced DLQ contract (${mode}) ===\n`);

  try {
    console.log('1. Configuration is applied by the selected broker...');
    await clean();
    await queue.setDlqConfigAsync({
      autoRetry: true,
      autoRetryInterval: 5_000,
      maxAutoRetries: 4,
      maxAge: 120_000,
      maxEntries: 17,
    });
    const config = await queue.getDlqConfigAsync();
    check(
      config.autoRetry === true &&
        config.autoRetryInterval === 5_000 &&
        config.maxAutoRetries === 4 &&
        config.maxAge === 120_000 &&
        config.maxEntries === 17,
      'set/get DLQ config round-trips every option',
      JSON.stringify(config)
    );

    console.log('\n2. Entries, filters, pagination, stats, and attempt history...');
    await clean();
    const history = await failJobs([11], 3);
    const all = history.entries;
    const filtered = await queue.getDlqAsync({ reason: FAILURE_REASON });
    const paged = await queue.getDlqAsync({ limit: 1, offset: 0 });
    const stats = await queue.getDlqStatsAsync();
    check(history.processed === 3, 'the job consumed all configured attempts');
    check(
      all.length === 1 && all[0].attempts.length === 3,
      'the DLQ entry preserves the complete attempt history',
      JSON.stringify(all[0]?.attempts)
    );
    check(
      filtered.length === 1 && filtered[0].reason === FAILURE_REASON,
      'reason filtering is applied by the broker'
    );
    check(paged.length === 1, 'DLQ pagination returns the requested page');
    check(
      stats.total === 1 && stats.byReason[FAILURE_REASON] === 1,
      'DLQ statistics reflect authoritative broker state',
      JSON.stringify(stats)
    );

    console.log('\n3. Selective and id-based retry remove exactly the selected entries...');
    await clean();
    await failJobs([21, 22]);
    const retriedByFilter = await queue.retryDlqByFilterAsync({ reason: FAILURE_REASON, limit: 1 });
    check(retriedByFilter === 1, 'filtered retry honours its limit', String(retriedByFilter));
    let remaining = await queue.getDlqAsync();
    check(remaining.length === 1, 'filtered retry leaves unselected entries in the DLQ');
    const retriedById = await queue.retryDlqAsync(remaining[0]?.job.id);
    check(retriedById === 1, 'id-based retry returns the exact applied count', String(retriedById));
    remaining = await queue.getDlqAsync();
    check(remaining.length === 0, 'all retried entries are removed from the DLQ');

    console.log('\n4. maxEntries evicts the oldest terminal jobs...');
    await clean();
    await queue.setDlqConfigAsync({ maxEntries: 2 });
    const bounded = await failJobs([31, 32, 33], 1, 2, [32, 33]);
    check(
      bounded.processed === 3 &&
        bounded.entries.length === 2 &&
        bounded.entries.map((entry) => entry.job.data.value).join(',') === '32,33',
      'maxEntries keeps only the two newest entries',
      bounded.entries.map((entry) => entry.job.data.value).join(',')
    );

    console.log('\n5. maxAge and purge expose exact state and counts...');
    await clean();
    await queue.setDlqConfigAsync({ maxAge: 100 });
    await failJobs([41, 42]);
    const expired = await eventually(
      () => queue.getDlqAsync({ expired: true }),
      (entries) => entries.length === 2
    );
    const expiredStats = await queue.getDlqStatsAsync();
    check(expired.length === 2 && expiredStats.expired === 2, 'maxAge marks both entries expired');
    const purged = await queue.purgeDlqAsync();
    check(purged === 2, 'purge returns the exact number removed', String(purged));
    check((await queue.getDlqAsync()).length === 0, 'purge leaves the DLQ empty');
  } catch (error) {
    console.error('   [FAIL] unexpected contract error:', error);
    failed++;
  } finally {
    try {
      await cleanupAll([() => queue.obliterateAsync(), () => queue.close(), () => harness.close()]);
    } catch (error) {
      console.error('   [FAIL] cleanup error:', error);
      failed++;
    }
  }

  // Starting another harness shuts shared managers/pools down: close the entire
  // normal-maintenance lifetime before starting the accelerated retry broker.
  if (failed === 0) {
    const automatic = await runAdvancedDlqAutoRetryContract(mode);
    passed += automatic.passed;
    failed += automatic.failed;
  }

  console.log(`\n=== Summary ===\nPassed: ${passed}\nFailed: ${failed}`);
  return { passed, failed };
}
