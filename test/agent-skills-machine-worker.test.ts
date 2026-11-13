/**
 * Agent Skills contract, part 6: one worker of the OrbStack Machine gate (see
 * docs/agents/README.md#skills and the bunqueue-running-machine-gates skill).
 *
 * Run: bun test test/agent-skills
 *
 * machine-worker.sh runs here with the fake `orb` of the lifecycle tests and a fake
 * `ssh` that plays a Machine whose steps advance between polls:
 * - every step that started or finished is printed, with its exit code, not only the
 *   newest progress line of each poll;
 * - the Machine-side content hash is recorded, and each command's log ends with its
 *   exit code (orb and rsync print nothing off a terminal);
 * - the package install asks dpkg for no terminal progress;
 * - `orb create` and the snapshot copy are stopped at the time bound and reported as an
 *   infrastructure failure (exit 4), the interrupted create staying marked for cleanup.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MACHINE_SKILL, machineBed } from './agent-skills-fakes';

const scratch = mkdtempSync(join(tmpdir(), 'bunqueue-machine-worker-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const text = (...path: string[]) => readFileSync(join(...path), 'utf8');

const PROGRESS = [
  ['[10:00:00] start', '[10:00:00] install started', '[10:00:25] install exit=0'],
  ['[10:00:25] unit started', '[10:09:50] unit exit=1', '[10:09:50] tcp started'],
  ['[10:18:46] tcp exit=0', '[10:18:46] done'],
];

/** A fake Machine behind `ssh`: three polls of progress, then DONE; `rsync` succeeds. */
function workerBed(label: string, createSleep = 0) {
  const dir = join(scratch, label);
  const bed = machineBed(dir, createSleep);
  const state = join(dir, 'state');
  const machine = join(dir, 'machine');
  for (const path of [state, machine, join(dir, 'snapshot')]) mkdirSync(path, { recursive: true });
  PROGRESS.forEach((lines, poll) =>
    writeFileSync(join(machine, `poll-${poll + 1}`), `${lines.join('\n')}\n`)
  );
  const fake = (name: string, body: string) => {
    writeFileSync(join(dir, 'fakes', name), `#!/bin/sh\n${body}`);
    chmodSync(join(dir, 'fakes', name), 0o755);
  };
  fake(
    'ssh',
    `m="${machine}"
cmd="$*"
case "$cmd" in
  *--content-hash*) echo x ;;
  *'tail -n +'*) from=$(printf '%s' "$cmd" | sed -E 's/.*tail -n \\+([0-9]+).*/\\1/')
    tail -n "+$from" "$m/progress.log" 2>/dev/null ;;
  *gate-out/DONE*) poll=$(($(cat "$m/polls" 2>/dev/null || echo 0) + 1)); echo $poll > "$m/polls"
    [ ! -e "$m/poll-$poll" ] || cat "$m/poll-$poll" >> "$m/progress.log"
    if [ $poll -ge ${PROGRESS.length} ]; then echo done; else echo running; fi ;;
esac\n`
  );
  fake('rsync', `[ ! -e "${bed.orb}/rsync-slow" ] || sleep 20\n`);
  const run = (env: Record<string, string> = {}) => {
    const result = Bun.spawnSync(
      [
        'bash',
        join(bed.repo, MACHINE_SKILL, 'scripts/machine-worker.sh'),
        ...['--distro', 'ubuntu:24.04', '--name', `bunqueue-ci-${label}`, '--arch', 'arm64'],
        ...[
          '--run-dir',
          join(dir, 'run'),
          '--state-dir',
          state,
          '--snapshot',
          join(dir, 'snapshot'),
        ],
        ...['--content-hash', 'x', '--bun-version', '1.4.4', '--steps', 'unit,tcp'],
      ],
      { env: { ...process.env, ...bed.env, BUNQUEUE_MACHINE_POLL_SECONDS: '1', ...env } }
    );
    return { code: result.exitCode, stderr: result.stderr.toString() };
  };
  return { bed, state, out: join(dir, 'run', `bunqueue-ci-${label}`), run };
}

describe('Machine gate: one worker', () => {
  test('prints every step with its exit code and records the hash and the exit codes', () => {
    const worker = workerBed('steps');
    const result = worker.run();
    expect(result.code).toBe(0);
    const printed = result.stderr.split('\n').filter((line) => line.startsWith('[bunqueue-ci-'));
    expect(printed).toEqual(PROGRESS.flat().map((line) => `[bunqueue-ci-steps] ${line}`));
    expect(text(worker.out, 'content-hash.txt')).toBe('x\n');
    for (const log of ['create.log', 'rsync.log', 'apt.log']) {
      expect({ log, text: text(worker.out, log) }).toEqual({
        log,
        text: log === 'rsync.log' ? '(exit 0)\n(exit 0)\n' : '(exit 0)\n',
      });
    }
    expect(text(worker.out, 'host.log')).toContain('apt-get install -y -qq -o Dpkg::Use-Pty=0');
    expect(existsSync(join(worker.state, 'creating.bunqueue-ci-steps'))).toBe(false);
  }, 60_000);

  test('an orb create that outlasts the bound is an infrastructure failure, still marked', () => {
    const worker = workerBed('create', 8);
    const result = worker.run({ BUNQUEUE_MACHINE_BOUND_SECONDS: '1' });
    expect(result.code).toBe(4);
    expect(text(worker.out, 'INFRA')).toContain('orb create did not finish within 1s');
    expect(text(worker.out, 'create.log')).toContain('(stopped after 1s)');
    // Cleanup waits for a Machine whose create is still marked, and deletes it.
    expect(existsSync(join(worker.state, 'creating.bunqueue-ci-create'))).toBe(true);
    expect(text(worker.state, 'created')).toBe('bunqueue-ci-create\n');
  }, 60_000);

  test('a snapshot copy that outlasts the bound is an infrastructure failure', () => {
    const worker = workerBed('copy');
    writeFileSync(join(worker.bed.orb, 'rsync-slow'), '');
    const result = worker.run({ BUNQUEUE_MACHINE_BOUND_SECONDS: '1' });
    expect(result.code).toBe(4);
    expect(text(worker.out, 'INFRA')).toContain('snapshot copy failed or timed out');
    expect(text(worker.out, 'rsync.log')).toContain('(stopped after 1s)');
  }, 60_000);
});
