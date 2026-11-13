/**
 * Bug Verification Tests
 *
 * Tests to verify if the remaining reported bugs are real or false positives.
 * JavaScript is single-threaded, so many "race conditions" cannot actually occur.
 *
 * Covered elsewhere: AckBatcher overflow (audit-ackbatcher-overflow.test.ts), a
 * writer served while readers hold the lock (lock.test.ts), and sequential
 * customId deduplication (push-operations.test.ts).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { RWLock } from '../src/shared/lock';

describe('Bug Verification: RWLock Writer Starvation', () => {
  test('VERIFY: fast path writer does not starve slow path', async () => {
    const lock = new RWLock();
    const events: string[] = [];

    console.log('\n--- Fast Path Writer Test ---');

    // Acquire first writer (fast path - no contention)
    const guard1 = await lock.acquireWrite(1000);
    events.push('writer1-acquired');

    // Start second writer while first holds lock (slow path)
    const writer2Promise = (async () => {
      events.push('writer2-waiting');
      const guard = await lock.acquireWrite(1000);
      events.push('writer2-acquired');
      guard.release();
      events.push('writer2-released');
    })();

    // Release first writer
    await Bun.sleep(50);
    guard1.release();
    events.push('writer1-released');

    await writer2Promise;

    console.log('Events:', events.join(' → '));

    // Verify second writer was notified after first released
    const writer1Released = events.indexOf('writer1-released');
    const writer2Acquired = events.indexOf('writer2-acquired');

    expect(writer2Acquired).toBeGreaterThan(writer1Released);
    console.log('\nVERIFIED: Slow path writer was notified');
  });
});

describe('Bug Verification: CustomIdMap Lookup', () => {
  let qm: QueueManager;

  beforeEach(() => {
    qm = new QueueManager();
  });

  afterEach(() => {
    qm.shutdown();
  });

  test('VERIFY FIX: concurrent pushes with same customId are properly deduplicated', async () => {
    const CUSTOM_ID = 'concurrent-test-456';
    const CONCURRENT_PUSHES = 10;

    console.log('\n--- Concurrent CustomId Push Test ---');

    // Push many jobs with same customId concurrently
    const pushPromises = Array.from({ length: CONCURRENT_PUSHES }, (_, i) =>
      qm.push('test-queue', {
        data: { attempt: i },
        customId: CUSTOM_ID,
      })
    );

    const results = await Promise.all(pushPromises);
    const uniqueIds = new Set(results.map((r) => String(r.id)));

    console.log(`Concurrent pushes: ${CONCURRENT_PUSHES}`);
    console.log(`Unique job IDs returned: ${uniqueIds.size}`);

    // All pushes should return the same ID
    expect(uniqueIds.size).toBe(1);

    // Only 1 job should be created (deduplicated)
    const stats = qm.getStats();
    console.log(`Jobs actually in queue: ${stats.waiting}`);

    // FIX VERIFIED: Exactly 1 job created despite concurrent pushes
    expect(stats.waiting).toBe(1);
    console.log('\nVERIFIED: CustomId race condition is fixed');
    console.log('CustomIdMap check now happens inside the shard lock');
  });
});
