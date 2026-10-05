/**
 * Repro (end to end, real worker thread): a SandboxedWorker per-job `timeout` above
 * the 2^31 - 1 ms timer limit, or Infinity, reached setTimeout as-is. The runtime
 * armed it after about 1 ms, so every job failed with "Job timed out after ...ms"
 * instead of running to completion.
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import { SandboxedWorker } from '../src/client/sandboxed';

let dir = '';
let processorPath = '';
let manager: QueueManager;
let worker: SandboxedWorker | null = null;

beforeAll(() => {
  manager = new QueueManager();
  dir = mkdtempSync(join(tmpdir(), 'bunqueue-sandboxed-long-timeout-'));
  processorPath = join(dir, 'processor.ts');
  writeFileSync(
    processorPath,
    `export default async (job: { data: { value: number } }) => {
  await Bun.sleep(100);
  return { doubled: job.data.value * 2 };
};\n`
  );
});

afterEach(async () => {
  await worker?.stop(true);
  worker = null;
});

afterAll(async () => {
  await manager.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

for (const [label, timeout] of [
  ['3_000_000_000 ms (above the timer limit)', 3_000_000_000],
  ['Infinity', Infinity],
] as const) {
  test(`a 100 ms job completes under timeout ${label}`, async () => {
    const queue = `sandboxed-long-timeout-${timeout}`;
    const completed: unknown[] = [];
    const failed: string[] = [];
    worker = new SandboxedWorker(queue, { processor: processorPath, timeout, manager });
    worker.on('completed', (_job, result) => completed.push(result));
    worker.on('failed', (_job, error) => failed.push(error.message));
    worker.on('error', () => undefined);
    await worker.start();

    await manager.push(queue, { data: { value: 21 } });
    for (let i = 0; i < 200 && completed.length + failed.length === 0; i++) await Bun.sleep(25);

    expect(failed).toEqual([]);
    expect(completed).toEqual([{ doubled: 42 }]);
  }, 20_000);
}
