import { summarizeProcesses } from './test-sandbox-checkpoints';
import type { ResourceSample, SuiteTelemetry, TestMetric } from './test-sandbox-telemetry';

interface RunReport {
  schemaVersion: 1;
  generatedAt: string;
  mode: 'parallel' | 'sequential';
  durationMs: number;
  passed: boolean;
  baseline?: string;
  suites: SuiteTelemetry[];
}

function formatBytes(value: number): string {
  const absolute = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (absolute >= 1024 ** 3) return `${sign}${(absolute / 1024 ** 3).toFixed(2)} GiB`;
  if (absolute >= 1024 ** 2) return `${sign}${(absolute / 1024 ** 2).toFixed(1)} MiB`;
  if (absolute >= 1024) return `${sign}${(absolute / 1024).toFixed(1)} KiB`;
  return `${value.toFixed(0)} B`;
}

function formatDuration(value: number): string {
  if (value >= 60_000) return `${(value / 60_000).toFixed(2)} min`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value.toFixed(1)} ms`;
}

function delta(current: number, baseline: number): number {
  return baseline === 0 ? 0 : ((current - baseline) / baseline) * 100;
}

type BaselineSuite = Pick<
  SuiteTelemetry,
  'suite' | 'exitCode' | 'durationMs' | 'resultsComplete'
> & {
  tests: Pick<SuiteTelemetry['tests'], 'passed' | 'failed' | 'skipped' | 'errors'>;
  resources: Pick<SuiteTelemetry['resources'], 'memoryPeakBytes'>;
};

async function readBaseline(path: string | null): Promise<{ suites: BaselineSuite[] } | null> {
  if (!path) return null;
  try {
    const parsed = (await Bun.file(path).json()) as { suites?: BaselineSuite[] } | null;
    // Syntactically valid JSON is not enough. A baseline written by an older schema has
    // no `tests` on its suites, and `suitePassed` would dereference it and throw from
    // inside `writeRunReport` AFTER the whole run: the 15 minutes of work would end with
    // no `summary.json` and no `summary.md` at all. An unusable baseline is worth less
    // than the report it would destroy.
    if (!Array.isArray(parsed?.suites)) return null;
    if (
      !parsed.suites.every(
        (suite) =>
          typeof suite?.suite === 'string' &&
          Number.isSafeInteger(suite.exitCode) &&
          Number.isFinite(suite.durationMs) &&
          suite.durationMs >= 0 &&
          suite.tests &&
          [suite.tests.passed, suite.tests.failed, suite.tests.skipped].every(
            (value) => Number.isSafeInteger(value) && value >= 0
          ) &&
          (suite.tests.errors === undefined ||
            (Number.isSafeInteger(suite.tests.errors) && suite.tests.errors >= 0)) &&
          (suite.resultsComplete === undefined || typeof suite.resultsComplete === 'boolean') &&
          Number.isFinite(suite.resources?.memoryPeakBytes) &&
          suite.resources.memoryPeakBytes >= 0
      )
    ) {
      return null;
    }
    return { suites: parsed.suites };
  } catch {
    return null;
  }
}

function addBaselineSignals(current: SuiteTelemetry, baseline?: BaselineSuite): void {
  // A 0/0/0 run must not become the duration and peak-memory baseline the next run is
  // compared against: it observed nothing, so every later run would look like a
  // regression against nothing.
  if (!baseline || !suitePassed(baseline)) return;
  const durationDelta = delta(current.durationMs, baseline.durationMs);
  if (durationDelta >= 25 && current.durationMs - baseline.durationMs >= 30_000) {
    current.anomalies.push(`duration regression vs baseline: +${durationDelta.toFixed(1)}%`);
  }
  const memoryDelta = delta(current.resources.memoryPeakBytes, baseline.resources.memoryPeakBytes);
  if (
    memoryDelta >= 25 &&
    current.resources.memoryPeakBytes - baseline.resources.memoryPeakBytes >= 64 * 1024 ** 2
  ) {
    current.anomalies.push(`peak-memory regression vs baseline: +${memoryDelta.toFixed(1)}%`);
  }
}

function slowTests(suites: SuiteTelemetry[], limit = 20): TestMetric[] {
  return suites
    .flatMap((suite) => suite.tests.cases)
    .filter((test): test is TestMetric & { durationMs: number } => test.durationMs !== undefined)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, limit);
}

function suiteTable(suites: SuiteTelemetry[]): string[] {
  const rows = [
    '| Suite | Status | Duration | Pass / Fail / Skip | Peak RAM | RAM delta | CPU avg / p95 / peak | PID peak | Anomalies |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const suite of suites) {
    const resources = suite.resources;
    rows.push(
      `| ${suite.suite} | ${suiteVerdict(suite)} | ${formatDuration(suite.durationMs)} | ${suite.tests.passed} / ${suite.tests.failed} / ${suite.tests.skipped} | ${formatBytes(resources.memoryPeakBytes)} (${resources.memoryPeakPercent.toFixed(1)}%) | ${formatBytes(resources.memoryDeltaBytes)} | ${resources.cpuAveragePercent.toFixed(1)}% / ${resources.cpuP95Percent.toFixed(1)}% / ${resources.cpuPeakPercent.toFixed(1)}% | ${resources.pidsPeak} | ${suite.anomalies.join('; ') || 'none'} |`
    );
  }
  return rows;
}

function resourceTable(suites: SuiteTelemetry[]): string[] {
  const rows = [
    '| Suite | Samples | Tests/s | RAM start / p95 / end / peak | RAM slope | Block read / write | Network RX / TX |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const suite of suites) {
    const resources = suite.resources;
    const observedTests = suite.tests.passed + suite.tests.failed + suite.tests.skipped;
    const testsPerSecond = suite.durationMs > 0 ? observedTests / (suite.durationMs / 1000) : 0;
    rows.push(
      `| ${suite.suite} | ${resources.sampleCount} | ${testsPerSecond.toFixed(2)} | ${formatBytes(resources.memoryStartBytes)} / ${formatBytes(resources.memoryP95Bytes)} / ${formatBytes(resources.memoryEndBytes)} / ${formatBytes(resources.memoryPeakBytes)} | ${formatBytes(resources.memorySlopeBytesPerMinute)}/min | ${formatBytes(resources.blockReadBytes)} / ${formatBytes(resources.blockWriteBytes)} | ${formatBytes(resources.networkRxBytes)} / ${formatBytes(resources.networkTxBytes)} |`
    );
  }
  return rows;
}

function quiescentTable(suites: SuiteTelemetry[]): string[] {
  const measured = suites.flatMap((suite) =>
    suite.quiescent ? [{ suite: suite.suite, ...suite.quiescent }] : []
  );
  if (measured.length === 0) return [];
  const rows = [
    '## Quiescent checkpoints',
    '',
    'Idle cgroup readings taken inside the container before the suite command starts and after it and every descendant exit. Retained = anon+shmem after minus before; page cache is reclaimable and not counted. These, not the first/last samples above, drive the memory-growth signal of these suites.',
    '',
    '| Suite | anon+shmem before / after | Retained | Page cache after | Tasks before / after | Survivors |',
    '|---|---:|---:|---:|---:|---|',
  ];
  for (const { suite, before, after, retainedBytes, survivors } of measured) {
    rows.push(
      `| ${suite} | ${formatBytes(before.anonBytes + before.shmemBytes)} / ${formatBytes(after.anonBytes + after.shmemBytes)} | ${formatBytes(retainedBytes)} | ${formatBytes(after.fileBytes)} | ${before.pids} / ${after.pids} | ${summarizeProcesses(survivors) || 'none'} |`
    );
  }
  return [...rows, ''];
}

function integrationTable(suites: SuiteTelemetry[]): string[] {
  const files = suites
    .flatMap((suite) => suite.files.map((file) => ({ suite: suite.suite, ...file })))
    .sort((a, b) => b.durationMs - a.durationMs);
  if (files.length === 0) return [];
  return [
    '## Integration files',
    '',
    '| Suite | File | Duration | Pass / Fail |',
    '|---|---|---:|---:|',
    ...files.map(
      (file) =>
        `| ${file.suite} | ${file.file} | ${formatDuration(file.durationMs)} | ${file.passed} / ${file.failed} |`
    ),
    '',
  ];
}

function markdown(report: RunReport): string {
  const slow = slowTests(report.suites);
  const lines = [
    '# Test sandbox telemetry',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Mode: ${report.mode}`,
    `- Overall: ${report.passed ? 'PASS' : 'FAIL'}`,
    `- Wall time: ${formatDuration(report.durationMs)}`,
    `- Baseline: ${report.baseline ?? 'none (first telemetry run)'}`,
    '',
    'Resource metrics are container-level. They can be correlated with test timestamps but are not attributed as per-test heap ownership.',
    '',
    '## Suite KPIs',
    '',
    ...suiteTable(report.suites),
    '',
    '## Resource detail',
    '',
    ...resourceTable(report.suites),
    '',
    ...quiescentTable(report.suites),
    '## Slowest unit tests',
    '',
    '| File | Test | Status | Duration |',
    '|---|---|---:|---:|',
    ...slow.map(
      (test) =>
        `| ${test.file} | ${test.name.replaceAll('|', '\\|')} | ${test.status} | ${formatDuration(test.durationMs ?? 0)} |`
    ),
    '',
    ...integrationTable(report.suites),
    '## Interpretation',
    '',
    '- OOM, non-zero exits, memory pressure, PID pressure, strong end-to-start growth, and material baseline regressions are reported as anomalies.',
    '- A memory-growth signal is evidence to investigate, not proof of a leak; mixed suites intentionally populate caches and exercise different workloads.',
    '- Suites with quiescent checkpoints are chains of different processes, so their first and last samples belong to different phases and their RAM delta is context only; the growth signal and outlived-process check use the checkpoints.',
    '- Use the NDJSON samples to correlate changes with timestamps in the complete suite log.',
    '',
  ];
  return lines.join('\n');
}

export async function writeSuiteArtifacts(
  logDir: string,
  suite: SuiteTelemetry,
  samples: ResourceSample[]
): Promise<void> {
  const ndjson = samples.map((sample) => JSON.stringify(sample)).join('\n');
  await Promise.all([
    Bun.write(`${logDir}/${suite.suite}.metrics.ndjson`, ndjson ? `${ndjson}\n` : ''),
    Bun.write(`${logDir}/${suite.suite}.summary.json`, `${JSON.stringify(suite, null, 2)}\n`),
  ]);
}

export async function writeRunReport(input: {
  logDir: string;
  mode: RunReport['mode'];
  durationMs: number;
  suites: SuiteTelemetry[];
  baselinePath: string | null;
}): Promise<RunReport> {
  const baseline = await readBaseline(input.baselinePath);
  for (const suite of input.suites) {
    addBaselineSignals(
      suite,
      baseline?.suites.find((candidate) => candidate.suite === suite.suite)
    );
  }
  const report: RunReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: input.mode,
    durationMs: input.durationMs,
    passed: input.suites.every(suitePassed),
    ...(baseline && input.baselinePath && { baseline: input.baselinePath }),
    suites: input.suites,
  };
  await Promise.all([
    Bun.write(`${input.logDir}/summary.json`, `${JSON.stringify(report, null, 2)}\n`),
    Bun.write(`${input.logDir}/summary.md`, markdown(report)),
    ...input.suites.map((suite) =>
      Bun.write(
        `${input.logDir}/${suite.suite}.summary.json`,
        `${JSON.stringify(suite, null, 2)}\n`
      )
    ),
  ]);
  return report;
}
interface SuiteResult {
  exitCode: number;
  tests: { passed: number; failed: number; skipped: number; errors?: number };
  resultsComplete?: boolean;
}

/** Shared by container retention, JSON/Markdown verdicts, SDKs and baseline selection. */
export function suitePassed(suite: SuiteResult): boolean {
  if (suite.exitCode !== 0 || suite.tests.failed !== 0 || suite.resultsComplete === false)
    return false;
  if ((suite.tests.errors ?? 0) !== 0) return false;
  return (
    [suite.tests.passed, suite.tests.skipped].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    ) && suite.tests.passed + suite.tests.skipped > 0
  );
}

function suiteVerdict(suite: SuiteResult): string {
  if (suite.exitCode !== 0 || suite.tests.failed > 0 || (suite.tests.errors ?? 0) > 0)
    return 'FAIL';
  if (suite.resultsComplete === false) return 'FAIL (incomplete results)';
  return suitePassed(suite) ? 'PASS' : 'FAIL (no results)';
}
