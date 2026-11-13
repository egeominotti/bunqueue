/**
 * Agent Skills contract, part 4: the lifecycle of the OrbStack Machine gate (see
 * docs/agents/README.md#skills and the bunqueue-running-machine-gates skill).
 *
 * Run: bun test test/agent-skills
 *
 * machine-gate.sh runs here with a fake `orb` (whose daemon finishes a create after
 * its CLI is killed), `ssh`, `rsync`, `git` and `uname`:
 * - an interrupt during `orb create` leaves no Machine and no worker process;
 * - a create that appears only after the settle window is reported, never hidden;
 * - a Machine whose name exists is never touched, also when `orb list` is slow, and a
 *   failing `orb list` never reads as "the name is free";
 * - cleanup signals only live workers of its own gate;
 * - a burst of Ctrl-C (SIGINT to the whole process group) during cleanup still copies
 *   the logs back and deletes every Machine, and the cleanup note says which logs were
 *   copied; a failed `orb delete` is retried until `orb list` no longer shows the name,
 *   with every exit code recorded.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Bed, descendants, machineBed, running } from './agent-skills-fakes';

const scratch = mkdtempSync(join(tmpdir(), 'bunqueue-machine-lifecycle-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const runDir = (bed: Bed, id: string) => join(bed.repo, 'artifacts/machines', id);
const text = (...path: string[]) => readFileSync(join(...path), 'utf8');

/** Starts the gate, interrupts it once both creates are running, returns its exit code. */
async function interrupt(bed: Bed, id: string, signal: 'SIGTERM' | 'SIGINT', env = {}) {
  const gate = Bun.spawn(['bash', bed.gate, '--run-id', id], {
    env: { ...process.env, ...bed.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const started = () =>
    ['ci', 'debian'].every((distro) =>
      existsSync(join(bed.orb, `started-bunqueue-${distro}-${id}`))
    );
  for (let tick = 0; tick < 200 && !started(); tick++) await Bun.sleep(100);
  expect(started()).toBe(true);
  const tree = descendants(gate.pid);
  expect(tree.length).toBeGreaterThan(2);
  gate.kill(signal);
  const code = await gate.exited;
  expect(tree.filter(running)).toEqual([]);
  return code;
}

describe('Machine gate: interrupts', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`${signal} during orb create leaves no Machine and no worker`, async () => {
      const bed = machineBed(join(scratch, `bed-${signal}`), 60);
      expect(await interrupt(bed, 'intr', signal)).toBe(130);
      expect(bed.machines()).toEqual([]);
      expect(bed.deleted()).toEqual(['bunqueue-ci-intr', 'bunqueue-debian-intr']);
      const run = runDir(bed, 'intr');
      expect(text(run, 'run.env')).toContain('cleanup=deleted');
      expect(text(run, 'manifest.md')).toContain('INTERRUPTED');
      expect(text(run, 'cleanup.log')).toMatch(/^workers to stop: \d+ \d+$/m);
      expect(existsSync(join(run, 'delete.log'))).toBe(true);
    }, 60_000);
  }

  test('a create that appears after the settle window is reported as not deleted', async () => {
    const bed = machineBed(join(scratch, 'bed-late'), 60, 6);
    const code = await interrupt(bed, 'late', 'SIGTERM', { BUNQUEUE_MACHINE_SETTLE_SECONDS: '2' });
    expect(code).toBe(4);
    const env = text(runDir(bed, 'late'), 'run.env');
    expect(env).toContain('cleanup=not-deleted');
    expect(env).toMatch(/cleanup_note=NOT DELETED: .*bunqueue-ci-late.*bunqueue-debian-late/);
    expect(env).toContain('interrupted=yes');
    expect(text(runDir(bed, 'late'), 'manifest.md')).toContain('Machines not deleted');
    // The fake daemon then really finishes: the report was right not to claim "deleted".
    for (let tick = 0; tick < 100 && bed.machines().length < 2; tick++) await Bun.sleep(100);
    expect(bed.machines()).toEqual(['bunqueue-ci-late', 'bunqueue-debian-late']);
  }, 60_000);
});

describe('Machine gate: cleanup under repeated signals and failing deletes', () => {
  test.skipIf(!Bun.which('perl'))(
    'a burst of Ctrl-C during cleanup still copies the logs and deletes every Machine',
    async () => {
      const bed = machineBed(join(scratch, 'bed-burst'), 60);
      for (const flag of ['signal-prone', 'rsync-ok']) writeFileSync(join(bed.orb, flag), '');
      // detached: the gate leads a process group of its own, as under a terminal.
      const gate = spawn('bash', [bed.gate, '--run-id', 'burst'], {
        env: { ...process.env, ...bed.env },
        detached: true,
        stdio: 'ignore',
      });
      const exited = new Promise<number | null>((resolve) => gate.on('exit', resolve));
      const started = () =>
        ['ci', 'debian'].every((d) => existsSync(join(bed.orb, `started-bunqueue-${d}-burst`)));
      for (let tick = 0; tick < 200 && !started(); tick++) await Bun.sleep(100);
      expect(started()).toBe(true);
      let over = false;
      void exited.then(() => (over = true));
      while (!over) {
        try {
          process.kill(-gate.pid!, 'SIGINT');
        } catch {
          // The group is gone.
        }
        await Bun.sleep(30);
      }
      expect(await exited).toBe(130);
      expect(bed.machines()).toEqual([]);
      expect(bed.deleted()).toEqual(['bunqueue-ci-burst', 'bunqueue-debian-burst']);
      const run = runDir(bed, 'burst');
      expect(text(run, 'run.env')).toContain('cleanup=deleted');
      expect(text(run, 'run.env')).toMatch(
        /cleanup_note=.*logs copied from: bunqueue-ci-burst bunqueue-debian-burst; not copied from: none/
      );
      expect(text(run, 'run.env')).toContain(
        'delete_exit=bunqueue-ci-burst:0 bunqueue-debian-burst:0'
      );
      expect(text(run, 'delete.log')).toContain(
        'orb delete -f bunqueue-ci-burst: exit 0 (attempt 1)'
      );
      expect(existsSync(join(run, 'bunqueue-ci-burst/copied-back'))).toBe(true);
    },
    60_000
  );

  test('a failed orb delete is retried, and the note says the logs were not copied', () => {
    const bed = machineBed(join(scratch, 'bed-retry'), 0);
    writeFileSync(join(bed.orb, 'delete-fails'), '1');
    const run = Bun.spawnSync(
      ['bash', bed.gate, '--run-id', 'retry', '--distros', 'ubuntu:24.04'],
      {
        env: { ...process.env, ...bed.env },
      }
    );
    expect(run.exitCode).toBe(4); // the fake Machine has no SSH: an infrastructure failure
    expect(bed.machines()).toEqual([]);
    const dir = runDir(bed, 'retry');
    expect(text(dir, 'delete.log')).toContain(
      'orb delete -f bunqueue-ci-retry: exit 1 (attempt 1)'
    );
    expect(text(dir, 'delete.log')).toContain(
      'orb delete -f bunqueue-ci-retry: exit 0 (attempt 2)'
    );
    expect(text(dir, 'run.env')).toContain('delete_exit=bunqueue-ci-retry:1,0');
    expect(text(dir, 'run.env')).toMatch(
      /cleanup=deleted\ncleanup_note=.*logs copied from: none; not copied from: bunqueue-ci-retry/
    );
    expect(text(dir, 'manifest.md')).toContain(
      'exit codes per Machine, one per attempt: bunqueue-ci-retry:1,0'
    );
  }, 60_000);
});

describe('Machine gate: names and orb list', () => {
  for (const slow of [false, true]) {
    test(`an existing Machine is never touched${slow ? ' when orb list is slow' : ''}`, () => {
      const bed = machineBed(join(scratch, `bed-existing-${slow}`), 0);
      writeFileSync(join(bed.orb, 'machines', 'bunqueue-ci-taken'), '');
      if (slow) writeFileSync(join(bed.orb, 'list-slow'), '');
      const run = Bun.spawnSync(['bash', bed.gate, '--run-id', 'taken'], {
        env: { ...process.env, ...bed.env },
      });
      expect(run.exitCode).toBe(4);
      expect(bed.machines()).toEqual(['bunqueue-ci-taken']);
      expect(bed.deleted()).toEqual(['bunqueue-debian-taken']);
      expect(bed.calls()).not.toMatch(/^create .*bunqueue-ci-taken$/m);
      const dir = runDir(bed, 'taken');
      expect(text(dir, 'bunqueue-ci-taken/INFRA')).toContain('already exists');
      expect(text(dir, 'run.env')).toContain('cleanup=deleted');
      expect(text(dir, 'manifest.md')).toContain('INFRASTRUCTURE FAILURE');
      // Both workers had exited and been reaped: cleanup must not be handed their pids.
      expect(text(dir, 'cleanup.log')).toContain('workers to stop: none');
      expect(text(dir, 'cleanup.log')).toContain('left alone: none');
    }, 60_000);
  }

  test('a failing orb list is an infrastructure failure, never a free name', () => {
    const bed = machineBed(join(scratch, 'bed-list-fails'), 0);
    writeFileSync(join(bed.orb, 'list-fail-from'), '2'); // the preflight call succeeds
    const run = Bun.spawnSync(
      ['bash', bed.gate, '--run-id', 'nolist', '--distros', 'ubuntu:24.04'],
      { env: { ...process.env, ...bed.env } }
    );
    expect(run.exitCode).toBe(4);
    expect(bed.calls()).not.toMatch(/^create /m);
    expect(bed.machines()).toEqual([]);
    expect(text(runDir(bed, 'nolist'), 'bunqueue-ci-nolist/INFRA')).toContain('orb list failed');
  }, 60_000);
});

describe('Machine gate: cleanup signals only workers of its gate', () => {
  test('a pid whose parent is not the gate is left alone; a child of the gate is stopped', () => {
    const bed = machineBed(join(scratch, 'bed-cleanup'), 0);
    const cleanup = bed.gate.replace('machine-gate.sh', 'machine-cleanup.sh');
    const run = join(scratch, 'cleanup-run');
    const state = join(scratch, 'cleanup-state');
    mkdirSync(state, { recursive: true });
    const bystander = Bun.spawn(['sleep', '60']);
    const other = Bun.spawn(['sleep', '60']);
    const clean = (parent: number) =>
      Bun.spawnSync(
        [
          'bash',
          cleanup,
          '--run-dir',
          run,
          '--state-dir',
          state,
          '--pids',
          String(bystander.pid),
          '--parent',
          String(parent),
        ],
        { env: { ...process.env, ...bed.env } }
      ).exitCode;
    try {
      expect(clean(other.pid)).toBe(0);
      expect(running(bystander.pid)).toBe(true);
      expect(text(run, 'cleanup.log')).toContain(`left alone: ${bystander.pid}`);
      expect(clean(process.pid)).toBe(0);
      expect(running(bystander.pid)).toBe(false);
      expect(running(other.pid)).toBe(true);
    } finally {
      bystander.kill();
      other.kill();
    }
  }, 60_000);
});
