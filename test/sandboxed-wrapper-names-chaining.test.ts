/**
 * Issue #24: SandboxedWorker wrapper file names and event-method chaining.
 *
 * 1. Every wrapper script gets its own file, also for simultaneous calls and for calls
 *    in the same millisecond: a shared name lets one worker's stop() delete the file
 *    another worker's threads are loaded from.
 * 2. `on()` and `once()` return the worker, like Worker, so calls chain.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { SandboxedWorker } from '../src/client/sandboxed';
import { cleanupWrapperScript, createWrapperScript } from '../src/client/sandboxed/wrapper';

let dir = '';
let processor = '';
let manager: QueueManager;
const wrappers: string[] = [];
const workers: SandboxedWorker[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bunqueue-sandboxed-wrapper-'));
  processor = join(dir, 'processor.ts');
  writeFileSync(processor, 'export default async (job) => ({ value: job.data.value });\n');
  manager = new QueueManager();
});

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop(true).catch(() => undefined);
  for (const wrapper of wrappers.splice(0)) await cleanupWrapperScript(wrapper);
});

afterAll(async () => {
  await manager.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

function uniqueQueue(label: string): string {
  return `wrapper-${label}-${crypto.randomUUID()}`;
}

function wrapperDir(): string {
  return join(Bun.env.TMPDIR ?? '/tmp', 'bunqueue-workers');
}

/** Wrapper files that exist now for `queue`. */
async function wrapperFiles(queue: string): Promise<string[]> {
  const found: string[] = [];
  for await (const file of new Bun.Glob(`worker-${queue}-*.ts`).scan(wrapperDir())) {
    found.push(file);
  }
  return found.sort();
}

function sandboxed(queue: string): SandboxedWorker {
  const worker = new SandboxedWorker(queue, { processor, timeout: 10_000, manager });
  workers.push(worker);
  return worker;
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

describe('Issue #24: unique wrapper file names', () => {
  test('ten simultaneous calls for one queue create ten files', async () => {
    const queue = uniqueQueue('burst');
    const paths = await Promise.all(
      Array.from({ length: 10 }, () => createWrapperScript(queue, processor))
    );
    wrappers.push(...paths);
    expect(new Set(paths).size).toBe(10);
    expect(await wrapperFiles(queue)).toEqual(paths.map((path) => basename(path)).sort());
  });

  test('calls in the same millisecond, for one queue and for two, never share a file', async () => {
    const queue = uniqueQueue('same-ms');
    const other = uniqueQueue('same-ms-other');
    const now = spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    let paths: string[];
    try {
      paths = [
        await createWrapperScript(queue, processor),
        await createWrapperScript(queue, processor),
        ...(await Promise.all([
          createWrapperScript(queue, processor),
          createWrapperScript(other, processor),
        ])),
      ];
    } finally {
      now.mockRestore();
    }
    wrappers.push(...paths);
    expect(new Set(paths).size).toBe(4);
    expect(await wrapperFiles(queue)).toHaveLength(3);
    expect(await wrapperFiles(other)).toHaveLength(1);
  });

  test('two workers on one queue keep separate wrappers: one stop leaves the other working', async () => {
    const queue = uniqueQueue('workers');
    const first = sandboxed(queue);
    const second = sandboxed(queue);
    // Both wrappers are named in the same millisecond: the clock is frozen at "now"
    // for the two starts only, so nothing else sees a time jump.
    const now = spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      await Promise.all([first.start(), second.start()]);
    } finally {
      now.mockRestore();
    }
    const both = await wrapperFiles(queue);
    expect(both).toHaveLength(2);

    await first.stop();
    const remaining = await wrapperFiles(queue);
    expect(remaining).toHaveLength(1);
    expect(both).toContain(remaining[0]!);

    const results: unknown[] = [];
    second.on('completed', (_job, result) => results.push(result));
    await manager.push(queue, { data: { value: 7 } });
    await waitFor(() => results.length === 1, 'the remaining worker to complete a job');
    expect(results).toEqual([{ value: 7 }]);

    await second.stop();
    expect(await wrapperFiles(queue)).toEqual([]);
  }, 30_000);
});

describe('Issue #24: on() and once() return the worker for chaining', () => {
  test('every on() and once() overload returns the same worker', () => {
    const worker = sandboxed(uniqueQueue('chain'));
    const noop = () => undefined;
    const chained = worker
      .on('ready', noop)
      .on('closed', noop)
      .on('active', (job) => void job)
      .on('completed', (job, result) => void [job, result])
      .on('failed', (job, error) => void [job, error])
      .on('progress', (job, progress) => void [job, progress])
      .on('log', (job, message) => void [job, message])
      .on('error', (error) => void error)
      .once('ready', noop)
      .once('closed', noop)
      .once('active', (job) => void job)
      .once('completed', (job, result) => void [job, result])
      .once('failed', (job, error) => void [job, error])
      .once('progress', (job, progress) => void [job, progress])
      .once('log', (job, message) => void [job, message])
      .once('error', (error) => void error);
    expect(chained).toBe(worker);
    const events = ['ready', 'closed', 'active', 'completed', 'failed', 'progress', 'log', 'error'];
    for (const event of events) {
      expect({ event, listeners: worker.listenerCount(event) }).toEqual({ event, listeners: 2 });
    }
  });

  test('chained listeners run: on() on every event, once() a single time', async () => {
    const queue = uniqueQueue('chain-live');
    const worker = sandboxed(queue);
    const seen: string[] = [];
    let onceCompleted = 0;
    worker
      .once('ready', () => seen.push('ready'))
      .on('completed', (_job, result) => seen.push(`completed:${JSON.stringify(result)}`))
      .once('completed', () => onceCompleted++)
      .once('closed', () => seen.push('closed'));
    await worker.start();
    await manager.push(queue, { data: { value: 1 } });
    await manager.push(queue, { data: { value: 2 } });
    await waitFor(() => seen.length === 3, 'two completed jobs');
    await worker.stop();

    expect(seen).toEqual(['ready', 'completed:{"value":1}', 'completed:{"value":2}', 'closed']);
    expect(onceCompleted).toBe(1);
  }, 30_000);
});
