/** Receipts cannot override missing summaries or reported failures in real logs. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MACHINE_SKILL, writeMachine } from './agent-skills-fakes';
import { runBash } from './agent-skills-support';

const scratch = mkdtempSync(join(tmpdir(), 'bunqueue-machine-evidence-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let next = 0;
function classify(step: string, log: string) {
  const dir = join(scratch, `case-${next++}`);
  const name = 'bunqueue-ci-evidence';
  writeMachine(
    join(dir, name),
    { install: 0, 'build-client': 0, [step]: 0 },
    {
      install: 'installed\n',
      'build-client': 'built\n',
      'gate-runner': 'done\n',
      [step]: log,
    }
  );
  writeFileSync(
    join(dir, 'run.env'),
    `run_id=evidence\ndistros=ubuntu:24.04\nsteps=${step}\nmachines=${name}\ncleanup=deleted\n`
  );
  return runBash(`${MACHINE_SKILL}/scripts/machine-verdict.sh`, [dir]);
}

describe('Machine evidence: test result summaries', () => {
  const bunCases: [string, string, number][] = [
    ['empty', '', 4],
    ['missing final summary', ' 1 pass\n 0 fail\n', 4],
    ['missing failure counter', ' 1 pass\nRan 1 tests across 1 files. [1s]\n', 4],
    ['zero tests', ' 0 pass\n 0 fail\nRan 0 tests across 1 files. [1s]\n', 4],
    ['inconsistent total', ' 2 pass\n 0 fail\nRan 1 tests across 1 files. [1s]\n', 4],
    ['unaccounted total', ' 1 pass\n 0 fail\nRan 2 tests across 1 files. [1s]\n', 4],
    ['valid skips', ' 1 pass\n 1 skip\n 0 fail\nRan 2 tests across 1 files. [1s]\n', 5],
    [
      'truncated after earlier summary',
      ' 1 pass\n 0 fail\nRan 1 tests across 1 files. [1s]\n 2 pass\n',
      4,
    ],
    ['reported failures', ' 1 pass\n 1 fail\nRan 2 tests across 1 files. [1s]\n', 1],
    ['reported error', ' 1 pass\n 0 fail\n 1 error\nRan 1 tests across 1 files. [1s]\n', 1],
    ['reported errors', ' 1 pass\n 0 fail\n 2 errors\nRan 1 tests across 1 files. [1s]\n', 1],
    ['valid', ' 1 pass\n 0 fail\nRan 1 tests across 1 files. [1s]\n', 5],
  ];
  for (const step of ['unit', 'tinyfs']) {
    for (const [label, log, code] of bunCases) {
      test(`${step}: ${label} with step exit zero returns ${code}`, () => {
        expect(classify(step, log).code).toBe(code);
      });
    }
  }
  for (const [step, suite, assertions] of [
    ['tcp', 'Suites:', 'Assertions:'],
    ['embedded', '📁 Test Suites:', '📋 Individual Tests:'],
  ]) {
    const cases: [string, string, number][] = [
      ['empty', '', 4],
      ['missing assertions', `${suite} 1/1 passed\n`, 4],
      ['zero tests', `${suite} 1/1 passed\n${assertions} 0/0 passed\n`, 4],
      ['invalid counters', `${suite} 2/1 passed\n${assertions} 1/1 passed\n`, 4],
      ['failed suite', `${suite} 0/1 passed\n${assertions} 1/1 passed\n`, 1],
      ['failed assertion', `${suite} 1/1 passed\n${assertions} 0/1 passed\n`, 1],
      ['valid', `${suite} 1/1 passed\n${assertions} 1/1 passed\n`, 5],
    ];
    for (const [label, log, code] of cases) {
      test(`${step}: ${label} with step exit zero returns ${code}`, () => {
        expect(classify(step!, log).code).toBe(code);
      });
    }
  }
});

describe('Machine evidence: typecheck and format completion', () => {
  for (const [step, label, log, code] of [
    ['typecheck', 'empty', '', 4],
    ['typecheck', 'only one project finished', 'No type errors in 10 files\n', 4],
    ['typecheck', 'reported errors', '1 error\n', 1],
    [
      'typecheck',
      'both projects finished',
      'No type errors in 10 files\nNo type errors in 20 files\n',
      5,
    ],
    ['format', 'empty', '', 4],
    ['format', 'zero files', 'All 0 files are formatted\n', 4],
    [
      'format',
      'reported formatting failures',
      '1 files need formatting. Run bun fmt to fix them.\n',
      1,
    ],
    ['format', 'finished', 'All 10 files are formatted\n', 5],
  ] as const) {
    test(`${step}: ${label} returns ${code}`, () => {
      expect(classify(step, log).code).toBe(code);
    });
  }
});
