/** Regressions for the audit's late-create, ownership, interrupt and evidence gaps. */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineBed, running } from './agent-skills-fakes';
import {
  env,
  fake,
  finishedBed,
  runDir,
  stopOwned,
  text,
  until,
  workerBed,
} from './agent-skills-machine-audit-support';

const scratch = mkdtempSync(join(tmpdir(), 'bunqueue-machine-audit-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('Machine gate audit: uncertain creation and ownership', () => {
  test('a failed-but-accepted create is settled and deleted before returning', async () => {
    const dir = join(scratch, 'failed-create');
    const bed = machineBed(dir, 0);
    const orb = join(dir, 'fakes/orb');
    writeFileSync(
      orb,
      text(orb).replace(
        'else touch "$state/machines/$name" "$state/started-$name"; fi',
        'else daemon_create "$name" 2; touch "$state/started-$name"; exit 1; fi'
      )
    );
    const gate = Bun.spawn(['bash', bed.gate, '--run-id', 'failed', '--distros', 'ubuntu:24.04'], {
      env: env(bed, { BUNQUEUE_MACHINE_SETTLE_SECONDS: '4' }),
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const code = await gate.exited;
    await Bun.sleep(2300); // The fake daemon must have accepted and finished the request.
    expect(code).toBe(4);
    expect(bed.machines()).toEqual([]);
    expect(bed.deleted()).toEqual(['bunqueue-ci-failed']);
    expect(text(join(runDir(bed, 'failed'), 'run.env'))).toContain('cleanup=deleted');
  }, 20_000);

  test('concurrent same-name workers never delete a Machine owned by the other run', async () => {
    const dir = join(scratch, 'collision');
    const shared = join(dir, 'shared');
    mkdirSync(join(shared, 'machines'), { recursive: true });
    // Each worker sees an empty pre-create list, including after the other create.
    // The daemon, like OrbStack, accepts exactly one create of a given name.
    const orb = `state='${shared}'
case "$1" in
 list) if [ -e "$state/cleanup.$ACTOR" ]; then ls "$state/machines"; fi ;;
 create) for name; do :; done
   if mkdir "$state/machines/$name" 2>/dev/null; then echo "$ACTOR" > "$state/machines/$name/owner"; touch "$state/winner"; else exit 1; fi ;;
 info) echo '{"record":{"config":{"isolated":true,"isolate_network":true,"forward_ssh_agent":false}}}' ;;
 delete) name=$3; owner=$(cat "$state/machines/$name/owner" 2>/dev/null || echo absent)
   echo "$ACTOR:$owner" >> "$state/deleted"; rm -rf "$state/machines/$name" ;;
esac\n`;
    const workers = ['a', 'b'].map((actor) => {
      const path = join(dir, actor);
      const worker = workerBed(path, 'bunqueue-ci-collision');
      fake(join(path, 'fakes/orb'), orb);
      fake(
        join(path, 'fakes/ssh'),
        `for last; do :; done\n[ "$last" != true ] || exit 0\ntouch '${shared}/ssh.'"$ACTOR"\nsleep 3\nexit 1\n`
      );
      return { actor, ...worker };
    });
    const sharedEnv = { BUNQUEUE_MACHINE_CLAIM_ROOT: join(shared, 'claims') };
    const a = Bun.spawn(workers[0]!.args, {
      env: env(workers[0]!.bed, { ...sharedEnv, ACTOR: 'a' }),
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await until(() => existsSync(join(shared, 'winner')));
    const b = Bun.spawn(workers[1]!.args, {
      env: env(workers[1]!.bed, { ...sharedEnv, ACTOR: 'b' }),
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await b.exited;
    writeFileSync(join(shared, 'cleanup.b'), '');
    const clean = (w: (typeof workers)[number]) =>
      Bun.spawnSync(
        [
          'bash',
          w.bed.gate.replace('machine-gate.sh', 'machine-cleanup.sh'),
          '--run-dir',
          join(dir, w.actor, 'run'),
          '--state-dir',
          w.state,
        ],
        { env: env(w.bed, { ...sharedEnv, ACTOR: w.actor, BUNQUEUE_MACHINE_SETTLE_SECONDS: '1' }) }
      );
    try {
      clean(workers[1]!);
      expect(existsSync(join(shared, 'machines/bunqueue-ci-collision/owner'))).toBe(true);
      expect(
        existsSync(join(shared, 'deleted')) ? text(join(shared, 'deleted')) : ''
      ).not.toContain('b:a');
    } finally {
      await a.exited;
      writeFileSync(join(shared, 'cleanup.a'), '');
      clean(workers[0]!);
    }
  }, 25_000);
});

describe('Machine gate audit: interruption and time bounds', () => {
  test('--keep plus SIGTERM cannot report all Machines deleted (130)', async () => {
    const bed = machineBed(join(scratch, 'keep'), 30, 0);
    const gate = Bun.spawn(
      ['bash', bed.gate, '--run-id', 'keep', '--keep', '--distros', 'ubuntu:24.04'],
      {
        env: env(bed),
        stdout: 'ignore',
        stderr: 'ignore',
      }
    );
    await until(() => bed.machines().length === 1);
    gate.kill('SIGTERM');
    expect(await gate.exited).toBe(4);
    expect(bed.machines()).toEqual(['bunqueue-ci-keep']);
    expect(text(join(runDir(bed, 'keep'), 'manifest.md'))).toContain('INFRASTRUCTURE FAILURE');
  }, 20_000);

  test('a hung cleanup list is bounded and its descendants are stopped', async () => {
    const dir = join(scratch, 'hung-list');
    const bed = machineBed(dir, 0);
    const state = join(dir, 'state');
    const run = join(dir, 'run');
    mkdirSync(state);
    mkdirSync(run);
    writeFileSync(join(state, 'created'), 'bunqueue-ci-hung\n');
    writeFileSync(join(run, 'run.env'), 'run_id=hung\n');
    fake(join(dir, 'fakes/orb'), `sleep 30 & echo $! > '${dir}/child'; wait\n`);
    const cleanup = Bun.spawn(
      [
        'bash',
        bed.gate.replace('machine-gate.sh', 'machine-cleanup.sh'),
        '--run-dir',
        run,
        '--state-dir',
        state,
      ],
      {
        env: env(bed, { BUNQUEUE_MACHINE_BOUND_SECONDS: '1' }),
        stdout: 'ignore',
        stderr: 'ignore',
      }
    );
    let ended = false;
    void cleanup.exited.then(() => {
      ended = true;
    });
    try {
      await until(() => existsSync(join(dir, 'child')));
      // Two bounded queries can each need the 5s KILL grace: this fake inherits
      // cleanup's ignored TERM, like a stubborn CLI and its descendant can.
      for (let i = 0; i < 320 && !ended; i++) await Bun.sleep(50);
      expect(ended).toBe(true);
      expect(await cleanup.exited).toBe(4);
      expect(running(Number(text(join(dir, 'child'))))).toBe(false);
      expect(text(join(run, 'run.env'))).toContain('cleanup=not-deleted');
    } finally {
      if (!ended) {
        stopOwned(cleanup.pid);
        await cleanup.exited;
      }
    }
  }, 20_000);

  test('a timed-out snapshot copy leaves no live grandchild', async () => {
    const dir = join(scratch, 'orphan');
    const bed = machineBed(dir, 0);
    fake(join(dir, 'fakes/ssh'), 'exit 0\n');
    fake(
      join(dir, 'fakes/rsync'),
      `for last; do :; done
case "$last" in *@orb:bunqueue/) sleep 30 & echo $! > '${dir}/child'; wait ;; *) exit 1 ;; esac\n`
    );
    const gate = Bun.spawn(['bash', bed.gate, '--run-id', 'orphan', '--distros', 'ubuntu:24.04'], {
      env: env(bed, { BUNQUEUE_MACHINE_BOUND_SECONDS: '1' }),
      stdout: 'ignore',
      stderr: 'ignore',
    });
    expect(await gate.exited).toBe(4);
    const pid = Number(text(join(dir, 'child')));
    try {
      expect(running(pid)).toBe(false);
      expect(bed.machines()).toEqual([]);
    } finally {
      if (running(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 20_000);
});

describe('Machine gate audit: complete copy-back evidence', () => {
  for (const copy of ['partial', 'missing', 'runner', 'runner-missing', 'complete'] as const) {
    test(`${copy} copy-back: exit ${copy === 'complete' ? 0 : 4}`, async () => {
      const bed = finishedBed(join(scratch, `copy-${copy}`), copy);
      const gate = Bun.spawn(['bash', bed.gate, '--run-id', copy, '--distros', 'ubuntu:24.04'], {
        env: env(bed),
        stdout: 'ignore',
        stderr: 'ignore',
      });
      expect(await gate.exited).toBe(copy === 'complete' ? 0 : 4);
      expect(bed.machines()).toEqual([]);
      const manifest = text(join(runDir(bed, copy), 'manifest.md'));
      expect(manifest).toContain(copy === 'complete' ? '**PASS**' : 'INFRASTRUCTURE FAILURE');
    }, 20_000);
  }
});
