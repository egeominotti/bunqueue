/** Hung OrbStack/established SSH control queries must obey a time limit. */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { descendants, running } from './agent-skills-fakes';
import { env, fake, stopOwned, text, workerBed } from './agent-skills-machine-audit-support';

const scratch = mkdtempSync(join(tmpdir(), 'bunqueue-machine-control-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('Machine gate: bounded control queries', () => {
  test('SIGTERM during preflight stops the owned query and its descendants', async () => {
    const dir = join(scratch, 'preflight-interrupt');
    const worker = workerBed(dir, 'bunqueue-ci-preflight-interrupt');
    const childFile = join(dir, 'child');
    fake(join(dir, 'fakes/orb'), `sleep 30 & echo $! > '${childFile}'; wait\n`);
    const proc = Bun.spawn(['bash', worker.bed.gate, '--run-id', 'preflight-interrupt'], {
      env: env(worker.bed, { BUNQUEUE_MACHINE_CONTROL_SECONDS: '1' }),
      stdout: 'ignore',
      stderr: 'ignore',
    });
    let tree: number[] = [];
    let ended = false;
    void proc.exited.then(() => {
      ended = true;
    });
    try {
      for (let i = 0; i < 200 && !existsSync(childFile); i++) await Bun.sleep(25);
      expect(existsSync(childFile)).toBe(true);
      tree = descendants(proc.pid);
      expect(tree.length).toBeGreaterThan(1);
      proc.kill('SIGTERM');
      const code = await proc.exited;
      expect({ code, live: tree.filter(running) }).toEqual({ code: 130, live: [] });
      expect(worker.bed.machines()).toEqual([]);
      expect(worker.bed.calls()).not.toMatch(/^create /m);
    } finally {
      if (!ended) stopOwned(proc.pid);
      for (const pid of tree.filter(running)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
      await proc.exited;
    }
  }, 15_000);

  for (const stage of [
    'list',
    'info',
    'ready',
    'hash',
    'progress',
    'state',
    'gate-list',
    'gate-version',
  ] as const) {
    test(`hung ${stage} query fails and stops its descendant`, async () => {
      const dir = join(scratch, stage);
      const worker = workerBed(dir, `bunqueue-ci-control-${stage}`);
      const childFile = join(dir, 'child');
      const hang = `sleep 30 & echo $! > '${childFile}'; wait; exit 0`;
      const orb = join(dir, 'fakes/orb');
      fake(orb, `if [ "$1" = '${stage.replace('gate-', '')}' ]; then ${hang}; fi\n${text(orb)}`);
      const pattern = {
        ready: '*true',
        hash: '*--content-hash*',
        progress: '*tail*',
        state: '*gate-out/DONE*',
      };
      const target = stage in pattern ? pattern[stage as keyof typeof pattern] : '*never-match*';
      fake(
        join(dir, 'fakes/ssh'),
        `case "$*" in
 ${target}) ${hang} ;;
 *--content-hash*) echo x ;;
 *gate-out/DONE*) echo done ;;
esac\n`
      );
      fake(join(dir, 'fakes/rsync'), 'exit 0\n');
      const gate = stage.startsWith('gate-');
      const proc = Bun.spawn(
        gate
          ? ['bash', worker.bed.gate, '--run-id', stage, '--distros', 'ubuntu:24.04']
          : worker.args,
        {
          env: env(worker.bed, { BUNQUEUE_MACHINE_CONTROL_SECONDS: '1' }),
          stdout: 'ignore',
          stderr: 'ignore',
        }
      );
      let ended = false;
      void proc.exited.then(() => {
        ended = true;
      });
      try {
        for (let i = 0; i < 400 && !existsSync(childFile); i++) await Bun.sleep(25);
        expect(existsSync(childFile)).toBe(true);
        for (let i = 0; i < 120 && !ended; i++) await Bun.sleep(50);
        expect(ended).toBe(true);
        expect(await proc.exited).toBe(4);
        expect(running(Number(text(childFile)))).toBe(false);
        if (!gate) expect(text(join(worker.out, 'INFRA'))).toMatch(/failed|timed out/);
      } finally {
        if (!ended) {
          stopOwned(proc.pid);
          await proc.exited;
        }
        if (existsSync(childFile) && running(Number(text(childFile))))
          process.kill(Number(text(childFile)), 'SIGKILL');
      }
    }, 20_000);
  }
});
