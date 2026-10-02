/**
 * Reproduces a file-handle leak in the MCP workflow store access (pre-commit review).
 *
 * WorkflowDb opened a connection per call and closed it while statements prepared by
 * the engine's store helpers were still alive, so the connection (and its database,
 * WAL and shared-memory file handles) stayed open until garbage collection, which in
 * practice never reclaimed most of them. A long-running HTTP MCP server polling
 * bunqueue_list_workflow_executions accumulated open handles without bound.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowStore } from '../src/client/workflow/store';
import { WorkflowDb } from '../src/mcp/workflow/workflowDb';

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const fdDir = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
function openHandles(): number {
  Bun.gc(true);
  return readdirSync(fdDir).length;
}

describe('WorkflowDb', () => {
  test('repeated calls do not accumulate open file handles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bunqueue-wf-handles-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'wf.db');
    new WorkflowStore(path).close();

    const db = new WorkflowDb(path);
    cleanups.push(() => (db as { close?: () => void }).close?.());
    db.assertWorkflowStore();
    db.list();
    db.get('missing');
    const before = openHandles();
    // Only listing and signalling: other calls can happen to trigger the collection
    // that releases leaked connections, which would hide the leak.
    for (let i = 0; i < 100; i++) db.list();
    for (let i = 0; i < 100; i++) db.recordSignal('missing', 'approval', null);
    const after = openHandles();
    expect(after - before).toBeLessThan(10);
  });
});
