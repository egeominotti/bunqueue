#!/usr/bin/env bun
/**
 * Issue #72 - Bug Reproduction Tests
 *
 * Bug: When worker emits 'completed' event, calling getJobState() on that job
 * still returns 'active' instead of 'completed'.
 *
 * Root cause: In processor.ts, the ACK is fire-and-forget (`void ackBatcher.queue(...)`)
 * so the 'completed' event is emitted BEFORE the ACK reaches the server.
 */

import { Queue, Worker } from '../../src/client';

const TCP_PORT = parseInt(process.env.TCP_PORT ?? '16789');
const connOpts = { port: TCP_PORT };

let passed = 0;
let failed = 0;
const queues: Queue[] = [];
const workers: Worker[] = [];

function ok(msg: string) {
  console.log(`   ✅ ${msg}`);
  passed++;
}

function fail(msg: string) {
  console.log(`   ❌ ${msg}`);
  failed++;
}

function makeQueue(name: string): Queue {
  const q = new Queue(name, { connection: connOpts });
  queues.push(q);
  return q;
}

function makeWorker(
  name: string,
  processor: (job: any) => Promise<any>,
  opts: Record<string, any> = {}
): Worker {
  const w = new Worker(name, processor, {
    connection: connOpts,
    useLocks: false,
    ...opts,
  });
  workers.push(w);
  return w;
}

async function main() {
  console.log('=== Issue #72: Job State Race Condition Tests (TCP) ===\n');

  // ---------------------------------------------------------------
  // Test 1: getJobState() inside 'completed' event should return 'completed'
  // ---------------------------------------------------------------
  console.log('1. Testing getJobState() inside completed event callback...');
  try {
    const q = makeQueue('tcp-issue72-state-race');
    q.obliterate();
    await Bun.sleep(200);

    let stateInCallback: string | null = null;
    let completedFired = false;

    const w = makeWorker('tcp-issue72-state-race', async (job) => {
      return { processed: true };
    });

    w.on('completed', async (job) => {
      completedFired = true;
      // This is the bug: getJobState() returns 'active' here instead of 'completed'
      stateInCallback = await q.getJobState(job.id);
    });

    await q.add('task', { value: 1 });

    // Wait for completion
    for (let i = 0; i < 50; i++) {
      if (completedFired && stateInCallback !== null) break;
      await Bun.sleep(100);
    }

    if (!completedFired) {
      fail('completed event never fired');
    } else if (stateInCallback === 'completed') {
      ok(`getJobState() returned 'completed' inside completed callback`);
    } else {
      fail(
        `getJobState() returned '${stateInCallback}' inside completed callback (expected 'completed')`
      );
    }
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }

  // ---------------------------------------------------------------
  // Test 2: getJobState() should return 'completed' for multiple jobs
  // ---------------------------------------------------------------
  console.log('\n2. Testing getJobState() race with multiple concurrent jobs...');
  try {
    const q = makeQueue('tcp-issue72-multi-race');
    q.obliterate();
    await Bun.sleep(200);

    const statesInCallback: Record<string, string> = {};
    let completedCount = 0;
    const totalJobs = 5;

    const w = makeWorker(
      'tcp-issue72-multi-race',
      async (job) => {
        return { id: job.id };
      },
      { concurrency: 5 }
    );

    w.on('completed', async (job) => {
      const state = await q.getJobState(job.id);
      statesInCallback[job.id] = state;
      completedCount++;
    });

    // Add multiple jobs
    for (let i = 0; i < totalJobs; i++) {
      await q.add('task', { idx: i });
    }

    // Wait for all completions
    for (let i = 0; i < 100; i++) {
      if (completedCount >= totalJobs) break;
      await Bun.sleep(100);
    }

    if (completedCount < totalJobs) {
      fail(`Only ${completedCount}/${totalJobs} jobs completed`);
    } else {
      const wrongStates = Object.entries(statesInCallback).filter(([_, s]) => s !== 'completed');
      if (wrongStates.length === 0) {
        ok(`All ${totalJobs} jobs returned 'completed' state in callback`);
      } else {
        fail(
          `${wrongStates.length}/${totalJobs} jobs had wrong state in callback: ${JSON.stringify(wrongStates)}`
        );
      }
    }
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }

  // ---------------------------------------------------------------
  // Test 3: job.getState() (on job object) inside completed callback
  // ---------------------------------------------------------------
  console.log('\n3. Testing job.getState() inside completed event callback...');
  try {
    const q = makeQueue('tcp-issue72-job-getstate');
    q.obliterate();
    await Bun.sleep(200);

    let jobStateResult: string | null = null;
    let completedFired = false;

    const w = makeWorker('tcp-issue72-job-getstate', async (job) => {
      return { ok: true };
    });

    w.on('completed', async (job) => {
      completedFired = true;
      // Use job.getState() directly (the method on the job object)
      jobStateResult = await job.getState();
    });

    await q.add('task', { value: 1 });

    for (let i = 0; i < 50; i++) {
      if (completedFired && jobStateResult !== null) break;
      await Bun.sleep(100);
    }

    if (!completedFired) {
      fail('completed event never fired');
    } else if (jobStateResult === 'completed') {
      ok(`job.getState() returned 'completed' inside completed callback`);
    } else {
      fail(
        `job.getState() returned '${jobStateResult}' inside completed callback (expected 'completed')`
      );
    }
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }

  // Cleanup
  for (const w of workers) {
    try {
      await w.close();
    } catch {}
  }
  for (const q of queues) {
    try {
      q.obliterate();
    } catch {}
    try {
      await q.close();
    } catch {}
  }

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
