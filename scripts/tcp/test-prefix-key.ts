#!/usr/bin/env bun
/**
 * Test prefixKey Isolation (TCP Mode) — Issue #77
 *
 * Verifies that two clients connected to the SAME broker over TCP, using the
 * SAME logical queue name but DIFFERENT prefixKey values, are fully isolated:
 * jobs, worker pulls, counts, pause/resume, and cron schedulers must not bleed
 * across namespaces.
 */

import { Queue, Worker } from '../../src/client';

const QUEUE_NAME = 'tcp-test-prefix-key';
const TCP_PORT = parseInt(process.env.TCP_PORT ?? '16789');

const DEV_PREFIX = 'dev-77:';
const PROD_PREFIX = 'prod-77:';

function makeQueue(prefixKey: string) {
  return new Queue<{ env: string; n: number }>(QUEUE_NAME, {
    connection: { port: TCP_PORT },
    prefixKey,
  });
}

async function main() {
  console.log('=== Test prefixKey Isolation (TCP) ===\n');

  let passed = 0;
  let failed = 0;

  const dev = makeQueue(DEV_PREFIX);
  const prod = makeQueue(PROD_PREFIX);

  // Clean state for both namespaces
  dev.obliterate();
  prod.obliterate();
  await Bun.sleep(150);

  // Test 1: Logical name preserved on Queue
  console.log('1. Logical Queue.name preserved...');
  try {
    if (dev.name === QUEUE_NAME && prod.name === QUEUE_NAME) {
      console.log(`   ✅ Both queues report logical name "${QUEUE_NAME}"`);
      passed++;
    } else {
      console.log(`   ❌ Got dev="${dev.name}" prod="${prod.name}"`);
      failed++;
    }
  } catch (e) {
    console.log(`   ❌ ${e}`);
    failed++;
  }

  // Test 2: Job isolation — jobs added to dev are NOT visible from prod
  console.log('\n2. Job isolation across prefixes...');
  try {
    await dev.add('task', { env: 'dev', n: 1 });
    await dev.add('task', { env: 'dev', n: 2 });
    await dev.add('task', { env: 'dev', n: 3 });
    await prod.add('task', { env: 'prod', n: 1 });
    await Bun.sleep(150);

    const devCounts = await dev.getJobCountsAsync();
    const prodCounts = await prod.getJobCountsAsync();

    const devWaiting = devCounts.waiting ?? 0;
    const prodWaiting = prodCounts.waiting ?? 0;

    if (devWaiting === 3 && prodWaiting === 1) {
      console.log(`   ✅ dev=${devWaiting} waiting, prod=${prodWaiting} waiting`);
      passed++;
    } else {
      console.log(`   ❌ Expected dev=3 prod=1, got dev=${devWaiting} prod=${prodWaiting}`);
      failed++;
    }
  } catch (e) {
    console.log(`   ❌ ${e}`);
    failed++;
  }

  // Test 3: Worker scoping — a worker registered with DEV_PREFIX only sees dev jobs
  console.log('\n3. Worker scoped to dev only sees dev jobs...');
  try {
    dev.obliterate();
    prod.obliterate();
    await Bun.sleep(150);

    await dev.add('task', { env: 'dev', n: 1 });
    await dev.add('task', { env: 'dev', n: 2 });
    await prod.add('task', { env: 'prod', n: 1 });
    await prod.add('task', { env: 'prod', n: 2 });

    const seenByDevWorker: string[] = [];
    const devWorker = new Worker<{ env: string; n: number }>(
      QUEUE_NAME,
      async (job) => {
        seenByDevWorker.push(job.data.env);
        return { ok: true };
      },
      {
        concurrency: 2,
        connection: { port: TCP_PORT },
        useLocks: false,
        prefixKey: DEV_PREFIX,
      }
    );

    await Bun.sleep(1200);
    await devWorker.close();

    const wrongEnvs = seenByDevWorker.filter((e) => e !== 'dev');
    if (seenByDevWorker.length === 2 && wrongEnvs.length === 0) {
      console.log(`   ✅ dev worker processed 2 dev jobs, leaked 0 prod jobs`);
      passed++;
    } else {
      console.log(
        `   ❌ dev worker saw ${seenByDevWorker.length} jobs (${seenByDevWorker.join(',')}), prod-leaks=${wrongEnvs.length}`
      );
      failed++;
    }

    // The 2 prod jobs must still be waiting
    const prodCounts = await prod.getJobCountsAsync();
    const prodWaiting = prodCounts.waiting ?? 0;
    if (prodWaiting === 2) {
      console.log(`   ✅ prod still has 2 untouched jobs`);
      passed++;
    } else {
      console.log(`   ❌ prod waiting=${prodWaiting} (expected 2)`);
      failed++;
    }
  } catch (e) {
    console.log(`   ❌ ${e}`);
    failed++;
  }

  // Test 4: Worker scoped to prod only sees prod jobs
  console.log('\n4. Worker scoped to prod only sees prod jobs...');
  try {
    const seenByProdWorker: string[] = [];
    const prodWorker = new Worker<{ env: string; n: number }>(
      QUEUE_NAME,
      async (job) => {
        seenByProdWorker.push(job.data.env);
        return { ok: true };
      },
      {
        concurrency: 2,
        connection: { port: TCP_PORT },
        useLocks: false,
        prefixKey: PROD_PREFIX,
      }
    );

    await Bun.sleep(1200);
    await prodWorker.close();

    const wrongEnvs = seenByProdWorker.filter((e) => e !== 'prod');
    if (seenByProdWorker.length === 2 && wrongEnvs.length === 0) {
      console.log(`   ✅ prod worker processed 2 prod jobs, leaked 0 dev jobs`);
      passed++;
    } else {
      console.log(
        `   ❌ prod worker saw ${seenByProdWorker.length} jobs (${seenByProdWorker.join(',')}), dev-leaks=${wrongEnvs.length}`
      );
      failed++;
    }
  } catch (e) {
    console.log(`   ❌ ${e}`);
    failed++;
  }

  // Test 5: Pause isolation — pausing dev does NOT pause prod
  console.log('\n5. Pause isolation between prefixes...');
  try {
    dev.obliterate();
    prod.obliterate();
    await Bun.sleep(150);

    dev.pause();
    await Bun.sleep(150);

    const devPaused = await dev.isPausedAsync();
    const prodPaused = await prod.isPausedAsync();

    if (devPaused === true && prodPaused === false) {
      console.log(`   ✅ dev paused, prod NOT paused`);
      passed++;
    } else {
      console.log(`   ❌ dev paused=${devPaused}, prod paused=${prodPaused}`);
      failed++;
    }

    dev.resume();
    await Bun.sleep(100);
  } catch (e) {
    console.log(`   ❌ ${e}`);
    failed++;
  }

  // Test 6: Cron isolation — same scheduler ID under different prefixes coexist
  console.log('\n6. Cron isolation (same id, different prefixes)...');
  try {
    const schedId = 'shared-id';

    // Both queues upsert a scheduler with the SAME logical id.
    // Without prefix isolation the cron table PRIMARY KEY would collide.
    const devSched = await dev.upsertJobScheduler(
      schedId,
      { every: 60_000 },
      { name: 'task', data: { env: 'dev', n: 0 } }
    );
    const prodSched = await prod.upsertJobScheduler(
      schedId,
      { every: 90_000 },
      { name: 'task', data: { env: 'prod', n: 0 } }
    );

    if (!devSched || !prodSched) {
      console.log(
        `   ❌ One of the upserts returned null (dev=${!!devSched}, prod=${!!prodSched})`
      );
      failed++;
    } else {
      const devSchedulers = await dev.getJobSchedulers();
      const prodSchedulers = await prod.getJobSchedulers();

      const devHas = devSchedulers.some((s) => s.id === schedId);
      const prodHas = prodSchedulers.some((s) => s.id === schedId);

      if (devHas && prodHas && devSchedulers.length === 1 && prodSchedulers.length === 1) {
        console.log(`   ✅ Both prefixes carry their own "${schedId}" scheduler`);
        passed++;
      } else {
        console.log(
          `   ❌ devCount=${devSchedulers.length} (has=${devHas}), prodCount=${prodSchedulers.length} (has=${prodHas})`
        );
        failed++;
      }

      // Removing it from dev must NOT remove the prod copy
      await dev.removeJobScheduler(schedId);
      await Bun.sleep(100);

      const devAfter = await dev.getJobSchedulers();
      const prodAfter = await prod.getJobSchedulers();

      if (devAfter.length === 0 && prodAfter.length === 1) {
        console.log(`   ✅ Removing dev scheduler did not touch prod`);
        passed++;
      } else {
        console.log(`   ❌ After delete: dev=${devAfter.length}, prod=${prodAfter.length}`);
        failed++;
      }

      await prod.removeJobScheduler(schedId);
    }
  } catch (e) {
    console.log(`   ❌ ${e}`);
    failed++;
  }

  // Test 7: Backward compatibility — a queue without prefixKey is isolated from a prefixed one
  console.log('\n7. Unprefixed queue isolated from prefixed queues...');
  try {
    const plainName = 'tcp-test-prefix-key-plain';
    const plain = new Queue<{ env: string; n: number }>(plainName, {
      connection: { port: TCP_PORT },
    });
    const prefixed = new Queue<{ env: string; n: number }>(plainName, {
      connection: { port: TCP_PORT },
      prefixKey: DEV_PREFIX,
    });

    plain.obliterate();
    prefixed.obliterate();
    await Bun.sleep(150);

    await plain.add('task', { env: 'plain', n: 1 });
    await prefixed.add('task', { env: 'prefixed', n: 1 });
    await prefixed.add('task', { env: 'prefixed', n: 2 });
    await Bun.sleep(150);

    const plainCounts = await plain.getJobCountsAsync();
    const prefixedCounts = await prefixed.getJobCountsAsync();

    if ((plainCounts.waiting ?? 0) === 1 && (prefixedCounts.waiting ?? 0) === 2) {
      console.log(`   ✅ plain=1, prefixed=2 (no leakage)`);
      passed++;
    } else {
      console.log(
        `   ❌ plain.waiting=${plainCounts.waiting}, prefixed.waiting=${prefixedCounts.waiting}`
      );
      failed++;
    }

    plain.obliterate();
    prefixed.obliterate();
    plain.close();
    prefixed.close();
  } catch (e) {
    console.log(`   ❌ ${e}`);
    failed++;
  }

  // Cleanup
  dev.obliterate();
  prod.obliterate();
  dev.close();
  prod.close();

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
