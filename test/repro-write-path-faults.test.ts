/**
 * Fault-injection matrix for ACK completion writes: each scenario fails a
 * completion statement (always, once, or on a given call) during a scalar ACK
 * or a 6-job batch ACK, waits one event-loop turn, and records error, persisted
 * state, result rows, job index, in-memory completion sets, disk-full state and
 * storage log lines. Non-durable jobs are already on disk at ACK time (the pull
 * writes them out); buffered jobs are covered by repro-write-path-equivalence.
 * EXPECTED (fixtures/write-path-faults-2.9.11.jsonl) is the output of c43442c9.
 * It pins current behavior, including any inconsistency a deliberate fix may
 * later change; a pure optimization must reproduce it exactly. Injected faults
 * do not model a physically full filesystem (WAL growth, checkpoints).
 *
 * The matrix runs in a child process with a pinned shard count, because batch
 * ACKs extract jobs in shard order and the shard count follows the host's CPUs.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dir, 'fixtures');

const parseLines = (text: string): unknown[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));

test('completion writes reproduce 2.9.11 outcomes across the fault matrix', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '--preload',
      join(FIXTURES, 'pin-shard-count.ts'),
      join(FIXTURES, 'write-path-faults-runner.ts'),
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exitCode).toBe(0);
  const expected = parseLines(
    readFileSync(join(FIXTURES, 'write-path-faults-2.9.11.jsonl'), 'utf8')
  );
  expect(parseLines(stdout)).toEqual(expected);
}, 120_000);
