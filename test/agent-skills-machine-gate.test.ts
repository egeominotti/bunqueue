/**
 * Agent Skills contract, part 3: the OrbStack Machine gate (see
 * docs/agents/README.md#skills and the bunqueue-running-machine-gates skill).
 *
 * Run: bun test test/agent-skills
 *
 * Verdicts: machine-verdict.sh on fixture runs in bun's log format. Only the exact
 * known file and title pairs, with `node: command not found` and a passing shim rerun,
 * are the known environment gap (exit 3); a kept or uncleaned run is never evidence.
 * The lifecycle (workers, interrupts, cleanup) is in
 * test/agent-skills-machine-lifecycle.test.ts.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { read } from './agent-harness-support';
import { runBash } from './agent-skills-support';
import { MACHINE_SKILL, bunLog, knownGap, steps, writeMachine } from './agent-skills-fakes';

const VERDICT = `${MACHINE_SKILL}/scripts/machine-verdict.sh`;
const CANONICAL =
  'distros=ubuntu:24.04,debian:13\nsteps=unit,tcp,embedded,typecheck,format,tinyfs\n';
const scratch = mkdtempSync(join(tmpdir(), 'bunqueue-machine-gate-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const known = knownGap();
const gapSteps = steps({ unit: 1 });
const gapLogs = (unit = bunLog(known, 100)) => ({
  unit,
  'gap-asis': bunLog(known, 16),
  'gap-shim': bunLog([], 22),
});
type Machine = [Record<string, number>, Record<string, string>] | 'infra';
const PASS: Machine = [steps(), { unit: bunLog([], 100) }];
const GAP: Machine = [{ ...gapSteps, 'gap-asis': 1, 'gap-shim': 0 }, gapLogs()];

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

describe('Machine gate: the known environment gap', () => {
  test('names real tests of real files', () => {
    expect(known.length).toBeGreaterThan(0);
    for (const [file, title] of known) {
      const last = title.split(' > ').at(-1)!;
      expect({ file, title, found: read(file).includes(`'${last}'`) }).toEqual({
        file,
        title,
        found: true,
      });
    }
  });
});

describe('Machine gate: verdicts', () => {
  const swapped: [string, string][] = [...known.slice(1), [known[0]![0], 'some other test']];
  const cases: [string, Machine[], number, string?][] = [
    ['every step passed', [PASS, PASS], 0],
    ['only the known gap', [GAP, PASS], 3],
    [
      'one more failure',
      [
        [
          { ...gapSteps, 'gap-asis': 1, 'gap-shim': 0 },
          gapLogs(bunLog([...known, ['test/x.test.ts', 'x']], 100)),
        ],
      ],
      1,
    ],
    [
      'six failures, one of them another test',
      [[{ ...gapSteps, 'gap-asis': 1, 'gap-shim': 0 }, gapLogs(bunLog(swapped, 100))]],
      1,
    ],
    [
      'the right titles under the wrong file',
      [
        [
          { ...gapSteps, 'gap-asis': 1, 'gap-shim': 0 },
          gapLogs(
            bunLog(
              known.map(([, t]) => ['test/other.test.ts', t]),
              100
            )
          ),
        ],
      ],
      1,
    ],
    [
      'the as-is rerun passes',
      [
        [
          { ...gapSteps, 'gap-asis': 0, 'gap-shim': 0 },
          { ...gapLogs(), 'gap-asis': bunLog([], 22) },
        ],
      ],
      1,
    ],
    [
      'the shim rerun fails',
      [
        [
          { ...gapSteps, 'gap-asis': 1, 'gap-shim': 1 },
          { ...gapLogs(), 'gap-shim': bunLog([known[0]!], 21) },
        ],
      ],
      1,
    ],
    [
      'no "node: command not found"',
      [
        [
          { ...gapSteps, 'gap-asis': 1, 'gap-shim': 0 },
          gapLogs(bunLog(known, 100).replaceAll('node: command not found', 'exit 127')),
        ],
      ],
      1,
    ],
    [
      'an unhandled error besides the gap',
      [
        [
          { ...gapSteps, 'gap-asis': 1, 'gap-shim': 0 },
          gapLogs(bunLog(known, 100, '# Unhandled error between tests\n 1 error')),
        ],
      ],
      1,
    ],
    [
      'the gap plus a failed tcp step',
      [[{ ...gapSteps, tcp: 1, 'gap-asis': 1, 'gap-shim': 0 }, gapLogs()]],
      1,
    ],
    [
      'a step that never ran',
      [[{ install: 0, 'build-client': 0, unit: 0 }, { unit: bunLog([], 100) }]],
      1,
    ],
    ['infra and pass', ['infra', PASS], 4],
    ['infra and fail', ['infra', [steps({ tcp: 1 }), { unit: bunLog([], 100) }]], 1],
    ['the gap and infra', [GAP, 'infra'], 4],
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
