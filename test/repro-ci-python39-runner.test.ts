/**
 * REPRO — the SDK workflow's Python 3.9 job cannot start on `ubuntu-latest`.
 *
 * Run: bun test test/repro-ci-python39-runner.test.ts
 *
 * `ubuntu-latest` now resolves to Ubuntu 26.04, and `actions/setup-python` has no
 * Python 3.9 build for it: the job fails at setup with "The version '3.9' with
 * architecture 'x64' was not found for Ubuntu 26.04" (CI runs 43291604726 and
 * 43301509664 on `main`). The SDK gate and then the quality gate fail with it, so
 * CI's version gate never runs and no release can be cut.
 *
 * Contract pinned here: every Python matrix entry names its runner image, the
 * Python 3.9 entry runs on `ubuntu-24.04` (which still has 3.9 builds), and the
 * newer Python keeps running on `ubuntu-latest`, so the matrix still covers both
 * the oldest supported runtime and the current image.
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface PythonJob {
  'runs-on': string;
  strategy: { matrix: { python?: string[]; include?: { python: string; os: string }[] } };
}

const workflow = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, '../.github/workflows/sdk.yml'), 'utf8')
) as { jobs: Record<string, PythonJob> };
const python = workflow.jobs.python!;

/** Runner image per Python version, as GitHub expands the matrix. */
function runnerByPython(): Record<string, string> {
  const { matrix } = python.strategy;
  const entries: ({ python: string; os: string } | { python: string })[] =
    matrix.include ?? (matrix.python ?? []).map((version) => ({ python: version }));
  return Object.fromEntries(
    entries.map((entry) => [
      entry.python,
      python['runs-on'] === '${{ matrix.os }}' && 'os' in entry ? entry.os : python['runs-on'],
    ])
  );
}

test('the Python 3.9 job runs on an image that has a Python 3.9 build', () => {
  expect(runnerByPython()['3.9']).toBe('ubuntu-24.04');
});

test('the newest Python still runs on ubuntu-latest, and both versions stay covered', () => {
  const runners = runnerByPython();
  expect(Object.keys(runners).sort()).toEqual(['3.13', '3.9']);
  expect(runners['3.13']).toBe('ubuntu-latest');
});
