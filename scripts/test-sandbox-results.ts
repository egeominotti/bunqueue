import type { FileMetric } from './test-sandbox-telemetry';

interface Counts {
  passed: number;
  failed: number;
  skipped: number;
}

/** Product gates require the runner's final accounting, not positive partial output. */
export function productResultsComplete(
  suite: string,
  log: string,
  counts: Counts,
  files: FileMetric[]
): boolean | undefined {
  if (suite === 'unit') {
    const summaries = [...log.matchAll(/^Ran (\d+) tests? across (\d+) files?\.(?: .*)?$/gm)];
    const pass = [...log.matchAll(/^\s*(\d+) pass$/gm)];
    const fail = [...log.matchAll(/^\s*(\d+) fail$/gm)];
    const skip = [...log.matchAll(/^\s*(\d+) skip$/gm)];
    if (summaries.length !== 1 || pass.length !== 1 || fail.length !== 1 || skip.length > 1)
      return false;
    const total = Number(summaries[0][1]);
    return (
      Number.isSafeInteger(total) &&
      total > 0 &&
      Number(summaries[0][2]) > 0 &&
      counts.passed + counts.failed + counts.skipped === total
    );
  }
  if (suite !== 'tcp' && suite !== 'embedded') return undefined;
  const suitesPattern =
    suite === 'tcp'
      ? /^Suites: (\d+)\/(\d+) passed$/gm
      : /^(?:📁 )?Test Suites: (\d+)\/(\d+) passed$/gm;
  const assertionsPattern =
    suite === 'tcp'
      ? /^Assertions: (\d+)\/(\d+) passed$/gm
      : /^(?:📋 )?Individual Tests: (\d+)\/(\d+) passed$/gm;
  const suites = [...log.matchAll(suitesPattern)];
  const assertions = [...log.matchAll(assertionsPattern)];
  if (suites.length !== 1 || assertions.length !== 1) return false;
  if (suite === 'tcp' && !/^TCP FINAL SUMMARY$/m.test(log)) return false;
  const markers = [...log.matchAll(/^TEST_FILE_RESULT /gm)];
  if (files.length === 0 || markers.length !== files.length) return false;
  if (new Set(files.map((file) => file.file)).size !== files.length) return false;
  const passed = files.reduce((sum, file) => sum + file.passed, 0);
  const failed = files.reduce((sum, file) => sum + file.failed, 0);
  const successfulFiles = files.filter((file) => file.failed === 0).length;
  return (
    Number(suites[0][1]) === successfulFiles &&
    Number(suites[0][2]) === files.length &&
    Number(suites[0][1]) === Number(suites[0][2]) &&
    Number(assertions[0][1]) === passed &&
    Number(assertions[0][2]) === passed + failed &&
    Number(assertions[0][1]) === Number(assertions[0][2]) &&
    passed > 0 &&
    counts.passed === passed &&
    counts.failed === failed
  );
}
