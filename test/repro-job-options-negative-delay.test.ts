/**
 * Repro: a negative job `delay` must mean "ready now", never an error.
 *
 * `queue.add(name, data, { delay: runAt - Date.now() })` produces a negative delay
 * whenever `runAt` has already passed. Embedded `add`/`addBulk` accepted it on 2.9.10;
 * the shared job-options validator then made it throw (`delay must be at least 0`), as
 * TCP PUSH/PUSHB, HTTP, flows, cron templates, MCP and Cloud already did.
 *
 * Every entry point (embedded and TCP add/addBulk, flows, HTTP, MCP, Cloud, cron
 * templates) now accepts it, with 2.9.10's result: `runAt = createdAt + delay`, a run
 * time in the past, so the job is `waiting` (never `delayed`), nothing is in the delayed
 * index, and it is pulled at once, AHEAD of earlier ready jobs (the waiting queue orders
 * by `runAt`; repro-compat-job-past-run-time.test.ts). NaN, non-finite and non-numeric
 * delays are still rejected (a numeric string is its number). `changeDelay` applies a
 * negative delay the same way, as 2.9.10 did.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { createJob } from '../src/domain/job/create';
import {
  delayArgument,
  validateDelayArgument,
  validateJobOptions,
} from '../src/domain/job/options';
import { jobId } from '../src/domain/types/job';
import { cronTemplateError } from '../src/infrastructure/scheduler/cron/validation';
import { routeQueueJobOperations } from '../src/infrastructure/server/http-routes/queueJobs';
import type { HandlerContext } from '../src/infrastructure/server/types';
import { handleCommand as handleCloud } from '../src/infrastructure/cloud/commandHandler';
import { closeHarness, MODES, startHarness, type CoreE2eHarness } from './docs-guide-support';
import { startMcp } from './mcp-harness';

const PAST = -5_000;
const YEAR = 365 * 86_400_000;

let harness: CoreE2eHarness | null = null;
let manager: QueueManager | null = null;

afterEach(async () => {
  await closeHarness(harness);
  harness = null;
  manager?.shutdown();
  manager = null;
});

/** The stored job is ready with its past run time: not delayed, not in the delayed index. */
async function expectRunsNow(broker: QueueManager, id: string): Promise<void> {
  const job = await broker.getJob(jobId(id));
  expect(job).not.toBeNull();
  expect(job!.runAt).toBe(job!.createdAt + PAST);
  expect(await broker.getJobState(jobId(id))).toBe('waiting');
  expect(broker.getMemoryStats().delayedHeapTotal).toBe(0);
}

/** Pull every ready job of `queue` and return their names in delivery order. */
async function drainNames(broker: QueueManager, queue: string): Promise<string[]> {
  const names: string[] = [];
  for (;;) {
    const job = await broker.pull(queue, 0);
    if (!job) return names;
    names.push(job.name);
  }
}

describe('job options validator', () => {
  test('accepts a negative delay; NaN, Infinity and non-numbers stay rejected', () => {
    expect(validateJobOptions({ delay: -1 })).toBeNull();
    expect(validateJobOptions({ delay: -0.5 })).toBeNull();
    expect(validateJobOptions({ delay: -YEAR * 10 })).toBeNull();
    expect(validateJobOptions({ delay: Number.NaN })).toBe('delay must be a finite number');
    expect(validateJobOptions({ delay: -Infinity })).toBe('delay must be a finite number');
    expect(validateJobOptions({ delay: 'soon' })).toBe('delay must be a number');
    // 2.9.10 ran these: a numeric string and a delay above a year (2.9.10 compatibility).
    expect(validateJobOptions({ delay: '5' })).toBeNull();
    expect(validateJobOptions({ delay: YEAR + 1 })).toBeNull();
    expect(cronTemplateError({ jobOptions: { delay: -1 } })).toBeNull();
  });

  test('changeDelay/moveToDelayed keep a negative delay (2.9.10); ttl stays non-negative', () => {
    expect(validateDelayArgument(-1)).toBeNull();
    expect(delayArgument(-1)).toBe(-1);
    expect(validateDelayArgument(Number.NaN)).toBe('delay must be a finite number');
    expect(validateJobOptions({ ttl: -1 })).toBe('ttl must be at least 0');
    // A negative dedup/debounce window has already expired (2.9.10 never bounded it).
    expect(validateJobOptions({ debounceTtl: -1 })).toBeNull();
  });

  test('createJob stores a negative delay as a past run time, as 2.9.10 did', () => {
    const now = 1_700_000_000_000;
    const job = createJob(jobId('neg'), 'q', { data: {}, delay: PAST }, now);
    expect(job.runAt).toBe(now + PAST);
    const stamped = createJob(
      jobId('ts'),
      'q',
      { data: {}, delay: PAST, timestamp: now - 10 },
      now
    );
    expect(stamped.runAt).toBe(stamped.createdAt + PAST);
  });
});

describe.each(MODES)('negative delay runs now [%s]', (mode) => {
  test('Queue.add: waiting, pulled at once, ahead of an earlier delay-0 job', async () => {
    harness = await startHarness('negative-delay-add', mode);
    const queue = harness.queue('negative-delay-add');
    const broker = harness.brokerManager();
    await queue.add('first', { n: 1 });
    const late = await queue.add('late', { n: 2 }, { delay: PAST });
    await queue.add('third', { n: 3 }, { delay: 0 });

    expect([late.delay, late.opts.delay]).toEqual([0, 0]);
    expect(await queue.getJobState(late.id)).toBe('waiting');
    await expectRunsNow(broker, late.id);
    expect(await drainNames(broker, queue.name)).toEqual(['late', 'first', 'third']);
  });

  test('Queue.addBulk: waiting, pulled at once, ahead of earlier delay-0 jobs', async () => {
    harness = await startHarness('negative-delay-bulk', mode);
    const queue = harness.queue('negative-delay-bulk');
    const broker = harness.brokerManager();
    await queue.add('first', {});
    const jobs = await queue.addBulk([
      { name: 'late', data: {}, opts: { delay: PAST } },
      { name: 'third', data: {} },
    ]);

    expect([jobs[0].delay, jobs[0].opts.delay]).toEqual([0, 0]);
    expect(await queue.getJobState(jobs[0].id)).toBe('waiting');
    await expectRunsNow(broker, jobs[0].id);
    expect(await drainNames(broker, queue.name)).toEqual(['late', 'first', 'third']);
  });

  test('a flow child with a negative delay is waiting, not delayed', async () => {
    harness = await startHarness('negative-delay-flow', mode);
    const queueName = harness.unique('negative-delay-flow');
    const broker = harness.brokerManager();
    const node = await harness.flow().add({
      name: 'parent',
      queueName,
      data: {},
      children: [{ name: 'child', queueName, data: {}, opts: { delay: PAST } }],
    });

    const childId = node.children![0].job.id;
    await expectRunsNow(broker, childId);
    expect((await broker.pull(queueName, 0))?.name).toBe('child');
  });
});

describe('HTTP job routes accept a negative delay (ready at once)', () => {
  function context(): HandlerContext {
    manager ??= new QueueManager();
    return { queueManager: manager, authTokens: new Set<string>(), authenticated: false };
  }

  async function post(path: string, body: unknown) {
    const request = new Request(`http://localhost${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const response = await routeQueueJobOperations(
      request,
      new URL(request.url).pathname,
      'POST',
      context(),
      new Set()
    );
    if (!response) throw new Error(`no route for POST ${path}`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  test('POST /queues/:q/jobs and /jobs/bulk create waiting jobs ordered by run time', async () => {
    const single = await post('/queues/http-neg/jobs', { name: 'first', data: {}, delay: PAST });
    expect(single.status).toBe(200);
    const bulk = await post('/queues/http-neg/jobs/bulk', {
      jobs: [
        { name: 'second', data: {} },
        { name: 'third', data: {}, delay: PAST },
      ],
    });
    expect(bulk.status).toBe(200);

    const ids = [String(single.body.id), ...(bulk.body.ids as string[])];
    for (const id of [ids[0], ids[2]]) await expectRunsNow(manager!, id);
    // Past run times sort first (first was created earlier, so its run time is earliest).
    expect(await drainNames(manager!, 'http-neg')).toEqual(['first', 'third', 'second']);
  });
});

describe.each(MODES)('MCP add tools accept a negative delay [%s]', (mode) => {
  test('add_job, add_jobs_bulk, add_flow and add_cron', async () => {
    const m = await startMcp({ mode });
    try {
      const single = await m.call('bunqueue_add_job', {
        queue: 'mcp-neg',
        name: 'single',
        data: {},
        delay: PAST,
      });
      const bulk = await m.call('bunqueue_add_jobs_bulk', {
        queue: 'mcp-neg',
        jobs: [{ name: 'bulk', data: {}, delay: PAST }],
      });
      const flow = await m.call('bunqueue_add_flow', {
        name: 'root',
        queueName: 'mcp-neg-flow',
        children: [{ name: 'kid', queueName: 'mcp-neg', opts: { jobId: 'kid-1', delay: PAST } }],
      });
      const cron = await m.call('bunqueue_add_cron', {
        name: 'mcp-neg-cron',
        queue: 'mcp-neg-cron',
        data: {},
        repeatEvery: 60_000,
        delay: PAST,
      });
      expect([single, bulk, flow, cron].map((r) => (r.isError ? r.text : 'ok'))).toEqual([
        'ok',
        'ok',
        'ok',
        'ok',
      ]);
      const ids = [String(single.json.jobId), String((bulk.json.jobIds as string[])[0]), 'kid-1'];
      const states = [];
      for (const id of ids) {
        states.push((await m.call('bunqueue_get_job_state', { jobId: id })).json.state);
      }
      expect(states).toEqual(['waiting', 'waiting', 'waiting']);
    } finally {
      await m.close();
    }
  });
});

describe('Cloud job:push accepts a negative delay', () => {
  test('the job is waiting, not delayed', async () => {
    manager = new QueueManager();
    const cloud = await handleCloud(manager, {
      type: 'command',
      id: 'push-neg',
      action: 'job:push',
      queue: 'cloud-neg',
      data: { n: 1 },
      delay: PAST,
    } as never);
    expect(cloud).toMatchObject({ success: true });
    expect(manager.getStats().waiting).toBe(1);
    expect(manager.getStats().delayed).toBe(0);
  });
});
