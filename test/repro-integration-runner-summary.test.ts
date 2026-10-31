/**
 * The TCP and embedded integration runners (scripts/{tcp,embedded}/run-all-tests.ts)
 * read per-file assertion counts from a script's output, but they only recognized
 * the `Passed: N` / `Failed: N` block. test-websocket.ts (47 assertions),
 * test-issue-72-job-state-race.ts and test-queue-name-consistency.ts print their
 * own `Results: ...` line, so the sandbox telemetry recorded them as 0 passed,
 * 0 failed. The exit code still decided success, but the counts were lost.
 *
 * Every summary format the integration scripts print must parse to its real counts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTestSummary } from '../scripts/shared/test-summary';

const SCRIPTS = join(import.meta.dir, '..', 'scripts');

describe('parseTestSummary', () => {
  test.each([
    ['=== Summary ===\nPassed: 10\nFailed: 0\n', 0, { passed: 10, failed: 0 }],
    ['=== Summary ===\nPassed: 4\nFailed: 2\n', 1, { passed: 4, failed: 2 }],
    ['Results: 47 passed, 0 failed, 47 total', 0, { passed: 47, failed: 0 }],
    ['\n--- Results: 5 passed, 1 failed ---', 1, { passed: 5, failed: 1 }],
    ['\nResults: 8/8 tests passed\n', 0, { passed: 8, failed: 0 }],
    ['\nResults: 6/8 tests passed\n', 1, { passed: 6, failed: 2 }],
    // A metrics dump before the summary (test-monitoring) is not the failure count.
    ['totalFailed: 3\n=== Summary ===\nPassed: 6\nFailed: 0\n', 0, { passed: 6, failed: 0 }],
  ])('%j (exit %d)', (output, exitCode, expected) => {
    expect(parseTestSummary(output, exitCode)).toEqual(expected);
  });

  test('output without a summary falls back to the exit code', () => {
    expect(parseTestSummary('Fatal error: boom', 1)).toEqual({ passed: 0, failed: 1 });
    expect(parseTestSummary('', 0)).toEqual({ passed: 0, failed: 0 });
  });
});

describe('both runners use the shared parser', () => {
  test.each(['tcp', 'embedded'])('%s/run-all-tests.ts', (suite) => {
    const source = readFileSync(join(SCRIPTS, suite, 'run-all-tests.ts'), 'utf8');
    expect(source).toContain('parseTestSummary');
    expect(source).not.toMatch(/match\(\/Passed: /);
  });
});
