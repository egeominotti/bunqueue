import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suitePassed, writeRunReport } from '../scripts/test-sandbox-report';
import { createSuiteTelemetry } from '../scripts/test-sandbox-telemetry';
import { sandboxRunnerFixture } from './support/sandbox-runner-fixture';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('sandbox gates reject contradictory success and cleanup failures', () => {
  test('complete successful suites pass and remove all owned containers', async () => {
    const result = await sandboxRunnerFixture('success');
    directories.push(result.directory);
    expect(result.exitCode).toBe(0);
    expect(result.report.passed).toBe(true);
    expect(
      result.report.suites.every((suite: { resultsComplete: boolean }) => suite.resultsComplete)
    ).toBe(true);
    expect(result.calls.filter((call) => call.startsWith('rm '))).toHaveLength(3);
  });

  test('Bun errors between tests cannot pass with zero failed assertions', async () => {
    const result = await sandboxRunnerFixture('test-error');
    directories.push(result.directory);
    expect(result.exitCode).toBe(1);
    expect(result.report.passed).toBe(false);
    expect(result.report.suites.every((suite: { exitCode: number }) => suite.exitCode === 0)).toBe(
      true
    );
    expect(
      result.report.suites.every(
        (suite: { tests: { errors?: number } }) => suite.tests.errors === 1
      )
    ).toBe(true);
    expect(result.calls.filter((call) => call.startsWith('rm '))).toEqual([]);
  });

  test('a partial positive result without final suite evidence cannot pass', async () => {
    const result = await sandboxRunnerFixture('incomplete');
    directories.push(result.directory);
    expect(result.exitCode).toBe(1);
    expect(result.report.passed).toBe(false);
    expect(result.calls.filter((call) => call.startsWith('rm '))).toEqual([]);
  });

  test('a reported failure cannot pass solely because the command exits zero', () => {
    expect(
      suitePassed({
        exitCode: 0,
        tests: { passed: 1, failed: 1, skipped: 0 },
        resultsComplete: true,
      })
    ).toBe(false);
    expect(suitePassed({ exitCode: 0, tests: { passed: 0, failed: 1, skipped: 0 } })).toBe(false);
  });

  test('the real runner fails and retains suites whose summaries contain failures', async () => {
    const result = await sandboxRunnerFixture('failed-count');
    directories.push(result.directory);
    expect(result.exitCode).toBe(1);
    expect(result.report.passed).toBe(false);
    expect(result.report.suites).toHaveLength(3);
    expect(
      result.report.suites.every((suite: { tests: { failed: number } }) => suite.tests.failed === 1)
    ).toBe(true);
    expect(result.calls.filter((call) => call.startsWith('rm '))).toEqual([]);
  });

  test('the real runner fails and records a container removal error', async () => {
    const result = await sandboxRunnerFixture('cleanup-failure');
    directories.push(result.directory);
    expect(result.exitCode).toBe(1);
    expect(result.report.passed).toBe(false);
    expect(result.stderr).toContain('removal failed');
    expect(
      result.report.suites.every((suite: { anomalies: string[] }) =>
        suite.anomalies.some((entry) => entry.includes('cleanup'))
      )
    ).toBe(true);
  });

  test('an incomplete old baseline cannot prevent writing the current report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bunqueue-baseline-repro-'));
    directories.push(directory);
    const logPath = join(directory, 'unit.log');
    await Bun.write(logPath, ' 1 pass\n 0 fail\nRan 1 test across 1 file.\n');
    const telemetry = await createSuiteTelemetry({
      suite: 'unit',
      command: ['bun', 'test'],
      container: 'test',
      logPath,
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:01Z',
      exitCode: 0,
      oomKilled: false,
      samples: [],
    });
    const baselinePath = join(directory, 'baseline.json');
    await Bun.write(
      baselinePath,
      JSON.stringify({
        suites: [{ suite: 'unit', exitCode: 0, tests: { passed: 1, failed: 0, skipped: 0 } }],
      })
    );
    const report = await writeRunReport({
      logDir: directory,
      mode: 'parallel',
      durationMs: 1000,
      suites: [telemetry],
      baselinePath,
    });
    expect(report.passed).toBe(true);
    expect((await Bun.file(join(directory, 'summary.json')).json()).passed).toBe(true);
    expect(await Bun.file(join(directory, 'summary.md')).text()).toContain('Overall: PASS');
  });
});

describe('sandbox final result evidence', () => {
  const unit = ' 1 pass\n 1 skip\n 0 fail\nRan 2 tests across 1 file. [2.00ms]\n';
  const file = 'TEST_FILE_RESULT {"file":"a.ts","passed":1,"failed":0,"durationMs":1}\n';
  const tcp = `${file}TCP FINAL SUMMARY\nSuites: 1/1 passed\nAssertions: 1/1 passed\n`;
  const embedded = `${file}📁 Test Suites: 1/1 passed\n📋 Individual Tests: 1/1 passed\n`;

  test.each([
    ['unit', unit, true],
    ['tcp', tcp, true],
    ['embedded', embedded, true],
    ['unit', unit.replace('Ran 2', 'Ran 1'), false],
    ['unit', unit.replace(' 0 fail\n', ''), false],
    ['unit', `${unit} 1 fail\n 0 fail\n`, false],
    ['unit', ' 0 pass\n 0 fail\nRan 0 tests across 1 file.\n', false],
    ['tcp', file, false],
    ['tcp', tcp.replace('Suites: 1/1', 'Suites: 1/2'), false],
    ['tcp', tcp.replace('Assertions: 1/1', 'Assertions: 1/2'), false],
    ['tcp', tcp.replace('Assertions: 1/1', 'Assertions: 2/2'), false],
    ['tcp', tcp.replace('Suites: 1/1', 'Suites: 2/2'), false],
    ['tcp', tcp.replace(file, ''), false],
    ['tcp', tcp.replace(file, `${file}TEST_FILE_RESULT {oops\n`), false],
    ['tcp', tcp.replace(file, `${file}${file}`), false],
    ['tcp', tcp.replace('"passed":1', '"passed":-1'), false],
    ['embedded', embedded.replace('Individual Tests: 1/1', 'Individual Tests: 1/2'), false],
    ['embedded', embedded.replace('📁 Test Suites: 1/1 passed\n', ''), false],
    ['typescript', ' 1 pass\n 0 fail\n 1 error\n', false],
    ['typescript', ' 1 pass\n 0 fail\n17/17 checks passed\n', true],
  ])('%s validates its complete final evidence (%#)', async (suite, log, expected) => {
    const directory = await mkdtemp(join(tmpdir(), 'bunqueue-result-evidence-'));
    directories.push(directory);
    const logPath = join(directory, 'suite.log');
    await Bun.write(logPath, log);
    const telemetry = await createSuiteTelemetry({
      suite,
      command: ['test'],
      container: 'test',
      logPath,
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:01Z',
      exitCode: 0,
      oomKilled: false,
      samples: [],
    });
    expect(suitePassed(telemetry)).toBe(expected);
    expect(telemetry.exitCode).toBe(0);
  });
});
