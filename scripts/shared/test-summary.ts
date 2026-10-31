/**
 * Per-file assertion counts for the integration runners
 * (scripts/{tcp,embedded}/run-all-tests.ts), read from a script's own summary.
 *
 * Accepted formats, tried in this order:
 * - `Passed: N` and/or `Failed: N` (the `=== Summary ===` block)
 * - `Results: X passed, Y failed` (also `--- ... ---` and a trailing `, Z total`)
 * - `Results: X/Y tests passed` (failed = Y - X)
 *
 * The labels are matched as whole words: `totalFailed: 3` in a metrics dump printed
 * before the summary is not the failure count.
 *
 * Without a recognized summary: 0 passed, and 1 failed unless the exit code is 0.
 * A missing label of the `Passed`/`Failed` pair falls back the same way.
 */
export interface TestSummary {
  passed: number;
  failed: number;
}

export function parseTestSummary(output: string, exitCode: number): TestSummary {
  const fallbackFailed = exitCode === 0 ? 0 : 1;

  const passedLine = output.match(/\bPassed: (\d+)/);
  const failedLine = output.match(/\bFailed: (\d+)/);
  if (passedLine || failedLine) {
    return {
      passed: passedLine ? Number(passedLine[1]) : 0,
      failed: failedLine ? Number(failedLine[1]) : fallbackFailed,
    };
  }

  const counts = output.match(/Results: (\d+) passed, (\d+) failed/);
  if (counts) return { passed: Number(counts[1]), failed: Number(counts[2]) };

  const ratio = output.match(/Results: (\d+)\/(\d+) tests passed/);
  if (ratio) {
    const passed = Number(ratio[1]);
    return { passed, failed: Math.max(0, Number(ratio[2]) - passed) };
  }

  return { passed: 0, failed: fallbackFailed };
}
