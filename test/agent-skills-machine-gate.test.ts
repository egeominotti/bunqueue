/**
 * Agent Skills contract, part 3: the OrbStack Machine gate (see
 * docs/agents/README.md#skills and the bunqueue-running-machine-gates skill).
 *
 * Run: bun test test/agent-skills
 *
 * Verdicts: machine-verdict.sh on fixture runs in bun's log format. Any failed step,
 * the unit suite included, is a real failure (exit 1); exit 3, the former known node
 * gap, is retired; a kept or uncleaned run is never evidence.
 * The lifecycle (workers, interrupts, cleanup) is in
 * test/agent-skills-machine-lifecycle.test.ts.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBash } from './agent-skills-support';
import { MACHINE_SKILL, bunLog, steps, writeMachine } from './agent-skills-fakes';

const VERDICT = `${MACHINE_SKILL}/scripts/machine-verdict.sh`;
const CANONICAL =
  'distros=ubuntu:24.04,debian:13\nsteps=unit,tcp,embedded,typecheck,format,tinyfs\n';
const scratch = mkdtempSync(join(tmpdir(), 'bunqueue-machine-gate-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Machine = [Record<string, number>, Record<string, string>] | 'infra';
const PASS: Machine = [steps(), { unit: bunLog([], 100) }];
// A unit failure as the gate recorded the former node gap (exit 3 until it was
// fixed in the tests): node-less failures, the as-is rerun failing, the shim passing.
const NODE_LESS: [string, string][] = [
  [
    'test/repro-docker-version-gate-errors.test.ts',
    'an absent tag permits the normal release path',
  ],
  [
    'test/repro-release-source-commit.test.ts',
    'version gate resolves the exact release source commit > a new version is released from the pushed commit',
  ],
];
const FORMER_GAP: Machine = [
  { ...steps({ unit: 1 }), 'gap-asis': 1, 'gap-shim': 0 },
  {
    unit: bunLog(NODE_LESS, 100, 'bash: line 1: node: command not found'),
    'gap-asis': bunLog(NODE_LESS, 16, 'bash: line 1: node: command not found'),
    'gap-shim': bunLog([], 18),
  },
];

function verdict(label: string, machines: Machine[], env = `${CANONICAL}cleanup=deleted\n`) {
  const run = join(scratch, `verdict-${label.replace(/\W+/g, '-')}`);
  const names = machines.map((_, index) => `bunqueue-m${index}-t`);
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'run.env'), `run_id=t\n${env}machines=${names.join(',')}\n`);
  machines.forEach((machine, index) => {
    const dir = join(run, names[index]!);
    if (machine === 'infra') {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'INFRA'), 'orb create failed\n');
    } else writeMachine(dir, machine[0], machine[1]);
  });
  return runBash(VERDICT, [run]);
}

describe('Machine gate: verdicts', () => {
  const cases: [string, Machine[], number, string?][] = [
    ['every step passed', [PASS, PASS], 0],
    [
      'a failed unit suite',
      [PASS, [steps({ unit: 1 }), { unit: bunLog([['test/x.test.ts', 'x']], 100) }]],
      1,
    ],
    ['the former node gap: a real failure, never exit 3', [FORMER_GAP, PASS], 1],
    [
      'a step that never ran',
      [[{ install: 0, 'build-client': 0, unit: 0 }, { unit: bunLog([], 100) }]],
      1,
    ],
    ['infra and pass', ['infra', PASS], 4],
    ['infra and fail', ['infra', [steps({ tcp: 1 }), { unit: bunLog([], 100) }]], 1],
    ['a unit failure and infra', [FORMER_GAP, 'infra'], 1],
  ];
  for (const [label, machines, code] of cases) {
    test(`${label}: exit ${code}`, () => {
      const result = verdict(label, machines);
      expect({ label, code: result.code, stderr: result.stderr }).toEqual({
        label,
        code,
        stderr: '',
      });
      expect(result.stdout).toContain('- Verdict: **');
    });
  }

  test('the former node gap names the failed unit step and no gap verdict', () => {
    const result = verdict('former gap detail', [FORMER_GAP]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('failed: unit(exit 1)');
    expect(result.stdout).not.toMatch(/known.*gap/i);
  });

  const evidence: [string, string, number, string][] = [
    ['Machines kept with --keep', `${CANONICAL}cleanup=kept\n`, 5, 'DIAGNOSTIC'],
    ['no cleanup recorded', CANONICAL, 4, 'Machines: not recorded'],
    [
      'a step subset',
      'distros=ubuntu:24.04,debian:13\nsteps=unit,tcp\ncleanup=deleted\n',
      5,
      'steps unit,tcp only',
    ],
    [
      'Ubuntu alone, outside a release',
      'distros=ubuntu:24.04\nsteps=unit,tcp,embedded,typecheck,format,tinyfs\ncleanup=deleted\n',
      0,
      'candidate scope (a release also needs Debian 13)',
    ],
    ['a Machine not deleted', `${CANONICAL}cleanup=not-deleted\n`, 4, 'INFRASTRUCTURE'],
    ['an interrupted run', `${CANONICAL}cleanup=deleted\ninterrupted=yes\n`, 130, 'INTERRUPTED'],
    [
      'an interrupted run that left a Machine',
      `${CANONICAL}cleanup=not-deleted\ninterrupted=yes\n`,
      4,
      'Machines not deleted',
    ],
    [
      'an interrupted run without recorded cleanup',
      `${CANONICAL}interrupted=yes\n`,
      4,
      'INFRASTRUCTURE',
    ],
  ];
  for (const [label, env, code, needle] of evidence) {
    test(`${label}: exit ${code}`, () => {
      const result = verdict(label, [PASS], env);
      expect({ label, code: result.code, mentions: result.stdout.includes(needle) }).toEqual({
        label,
        code,
        mentions: true,
      });
    });
  }

  test('an unfinished Machine shows its recorded steps; the manifest shows hash and delete codes', () => {
    const run = join(scratch, 'verdict-partial');
    const machine = join(run, 'bunqueue-m0-t');
    writeMachine(machine, { install: 0, typecheck: 1 }, {});
    rmSync(join(machine, 'DONE'));
    writeFileSync(join(machine, 'content-hash.txt'), 'abc123\n');
    writeFileSync(
      join(run, 'run.env'),
      `run_id=t\n${CANONICAL}cleanup=deleted\ndelete_exit=bunqueue-m0-t:2,0\ninterrupted=yes\nmachines=bunqueue-m0-t\n`
    );
    const result = runBash(VERDICT, [run]);
    expect(result.code).toBe(130);
    for (const needle of [
      '(no DONE); steps recorded before it stopped: install(exit 0) typecheck(exit 1)',
      '| typecheck | 1 | 1 |',
      '| Content hash in the Machine | abc123 |',
      'exit codes per Machine, one per attempt: bunqueue-m0-t:2,0',
    ]) {
      expect({ needle, present: result.stdout.includes(needle) }).toEqual({
        needle,
        present: true,
      });
    }
  });

  test('a real failure outranks a Machine left behind', () => {
    expect(
      verdict(
        'fail and not deleted',
        [[steps({ tcp: 1 }), {}]],
        `${CANONICAL}cleanup=not-deleted\n`
      ).code
    ).toBe(1);
  });
});
