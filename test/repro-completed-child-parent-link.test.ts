import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueManager } from '../src/application/queueManager';
import type { Job } from '../src/domain/types/job';

let directory: string;
let manager: QueueManager;
const config = () => ({ dataPath: join(directory, 'jobs.db'), maxCompletedJobs: 1 });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bunqueue-completed-child-link-'));
  manager = new QueueManager(config());
});
afterEach(() => {
  manager.shutdown();
  rmSync(directory, { recursive: true, force: true });
});

function reopen(): void {
  manager.shutdown();
  manager = new QueueManager(config());
}

async function ack(job: Job): Promise<void> {
  expect((await manager.pull(job.queue))?.id).toBe(job.id);
  await manager.ack(job.id);
}

async function coldChild(): Promise<Job> {
  const child = await manager.push('child', { data: {}, durable: true });
  await ack(child);
  await ack(await manager.push('filler', { data: {}, durable: true }));
  return child;
}

async function linkBlockedParent() {
  const child = await coldChild();
  const other = await manager.push('other', { data: {}, durable: true });
  const parent = await manager.push('parent', { data: {}, dependsOn: [other.id], durable: true });
  await manager.updateJobParent(child.id, parent.id);
  expect(await manager.getJobState(parent.id)).toBe('waiting-children');
  return { child, other, parent };
}

test('linking a completed child preserves an independently blocked parent across restart', async () => {
  const { other, parent } = await linkBlockedParent();
  reopen();
  expect(manager.getQueueJobCounts('parent')['waiting-children']).toBe(1);
  expect(await manager.pull('parent')).toBeNull();
  await ack(other);
  expect((await manager.pull('parent', 500))?.id).toBe(parent.id);
});

test('a retried late-linked child wakes its blocked parent when it completes again', async () => {
  const { child, other, parent } = await linkBlockedParent();
  expect(manager.retryCompleted(child.queue, child.id)).toBe(1);
  await ack(other);
  expect(await manager.pull('parent', 30)).toBeNull();
  await ack(child);
  expect((await manager.pull('parent', 500))?.id).toBe(parent.id);
});

test('linking a completed child preserves a manual park until new child work arrives', async () => {
  const child = await coldChild();
  const parent = await manager.push('parent', { data: {}, durable: true });
  expect((await manager.pull('parent'))?.id).toBe(parent.id);
  expect(await manager.moveToWaitingChildren(parent.id)).toBe(true);
  await manager.updateJobParent(child.id, parent.id);
  reopen();
  expect(await manager.getJobState(parent.id)).toBe('waiting-children');
  expect(await manager.pull('parent')).toBeNull();
  const next = await manager.push('next', { data: {}, durable: true });
  await manager.updateJobParent(next.id, parent.id);
  reopen();
  expect(await manager.pull('parent')).toBeNull();
  await ack(next);
  expect((await manager.pull('parent', 500))?.id).toBe(parent.id);
});
