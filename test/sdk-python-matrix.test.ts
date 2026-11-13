/**
 * Contract of the SDK workflow's Python matrix.
 *
 * Run: bun test test/sdk-python-matrix.test.ts
 *
 * The matrix tests the oldest Python the SDK declares it supports and the newest
 * one, and the two must not drift apart: the oldest leg is read from
 * `requires-python` in `sdk/python/pyproject.toml`, never written twice. Every leg
 * names its runner image, so an image that loses a Python build (as Ubuntu 26.04
 * did for Python 3.9, CI runs 43291604726, 43301509664 and 43324514568) is a
 * visible one-line change, and the newest leg stays on `ubuntu-latest`.
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Leg {
  python?: string;
  os?: string;
}
interface Step {
  name?: string;
  if?: string;
}
interface PythonJob {
  'runs-on': string;
  strategy: { matrix: { include?: Leg[] } };
  steps: Step[];
}
interface PyProject {
  project: {
    'requires-python': string;
    classifiers: string[];
    'optional-dependencies': Record<string, string[]>;
  };
}

const root = join(import.meta.dir, '..');
const workflow = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/sdk.yml'), 'utf8')) as {
  jobs: Record<string, PythonJob>;
};
const job = workflow.jobs.python!;
const legs = job.strategy.matrix.include ?? [];
const { project } = Bun.TOML.parse(
  readFileSync(join(root, 'sdk/python/pyproject.toml'), 'utf8')
) as unknown as PyProject;

/** `3.10` -> 10: the minor version, the only part that differs between legs. */
function minor(version: string): number {
  const match = /^3\.(\d+)$/.exec(version);
  if (!match) throw new Error(`not a Python 3 minor version: ${version}`);
  return Number(match[1]);
}

/** Lower bound of `requires-python`, e.g. `>=3.10` -> `3.10`. */
function declaredMinimum(): string {
  const match = /^>=\s*(3\.\d+)$/.exec(project['requires-python'].trim());
  if (!match) throw new Error(`unexpected requires-python: ${project['requires-python']}`);
  return match[1]!;
}

const versions = legs.map((leg) => leg.python ?? '').sort((a, b) => minor(a) - minor(b));

test('every Python matrix leg names its Python version and its runner image', () => {
  expect(job['runs-on']).toBe('${{ matrix.os }}');
  expect(legs.length).toBeGreaterThanOrEqual(2);
  for (const leg of legs) {
    expect(leg.python, JSON.stringify(leg)).toMatch(/^3\.\d+$/);
    expect(leg.os, JSON.stringify(leg)).toMatch(/^ubuntu-(latest|\d+\.\d+)$/);
  }
  expect(new Set(versions).size).toBe(versions.length);
});

test('the oldest leg is the minimum Python that pyproject.toml declares', () => {
  expect(versions[0]).toBe(declaredMinimum());
});

test('the newest leg runs on ubuntu-latest and is a version the package classifies', () => {
  const newest = versions.at(-1)!;
  expect(minor(newest)).toBeGreaterThan(minor(declaredMinimum()));
  expect(legs.find((leg) => leg.python === newest)?.os).toBe('ubuntu-latest');
  expect(project.classifiers).toContain(`Programming Language :: Python :: ${newest}`);
});

test('no classifier names a Python older than the declared minimum', () => {
  const classified = project.classifiers
    .map((classifier) => /^Programming Language :: Python :: (3\.\d+)$/.exec(classifier)?.[1])
    .filter((version): version is string => version !== undefined);
  expect(classified).toContain(declaredMinimum());
  for (const version of classified) {
    expect(minor(version), version).toBeGreaterThanOrEqual(minor(declaredMinimum()));
  }
});

test('every step runs on every leg, except the soak, which names an existing leg', () => {
  const conditional = job.steps.filter((step) => step.if?.includes('matrix.python'));
  expect(conditional.map((step) => step.name)).toEqual(['Weekly sustained SDK soak']);
  const named = /matrix\.python == '([^']+)'/.exec(conditional[0]!.if!)?.[1];
  expect(versions).toContain(named!);
});

test('the test and mutation extras install on every supported Python', () => {
  for (const extra of ['test', 'mutation']) {
    for (const requirement of project['optional-dependencies'][extra] ?? []) {
      expect(requirement, extra).not.toContain('python_version');
    }
  }
  expect(project['optional-dependencies'].test).toContain('pytest==9.0.3');
});
