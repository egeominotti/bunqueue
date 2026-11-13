/** An exited launcher must not let descendants outlive a bounded command. */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineBed, running } from './agent-skills-fakes';
import { env, stopOwned, text, until } from './agent-skills-machine-audit-support';

const scratch = mkdtempSync(join(tmpdir(), 'bunqueue-machine-process-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('Machine process lifetime after its launcher exits', () => {
  for (const mode of ['pipe', 'silent', 'ignore-term'] as const) {
    test(`${mode} descendant is stopped; a bystander survives`, async () => {
      const dir = join(scratch, mode);
      const bed = machineBed(dir, 0);
      const childFile = join(dir, 'child');
      const resultFile = join(dir, 'result');
      const helper = bed.gate.replace('machine-gate.sh', 'machine-process.sh');
      const bystander = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
      const command =
        mode === 'ignore-term'
          ? 'trap "" TERM; sleep 30 & echo $! > "$1"; wait'
          : `sleep 30 ${mode === 'silent' ? '>/dev/null 2>&1 ' : ''}& echo $! > "$1"; exit 0`;
      const proc = Bun.spawn(
        [
          'bash',
          '-c',
          `source "$1"; rc=0; result=$(bounded 1 bash -c '${command}' _ "$2") || rc=$?; printf '%s\\n' "$rc" > "$3"`,
          '_',
          helper,
          childFile,
          resultFile,
        ],
        { env: env(bed), stdout: 'ignore', stderr: 'ignore' }
      );
      let ended = false;
      void proc.exited.then(() => {
        ended = true;
      });
      try {
        await until(() => existsSync(childFile));
        for (let i = 0; i < 60 && !ended; i++) await Bun.sleep(50);
        expect({ ended, descendantAlive: running(Number(text(childFile))) }).toEqual({
          ended: true,
          descendantAlive: false,
        });
        expect([0, 124]).toContain(Number(text(resultFile)));
        if (mode === 'ignore-term') expect(Number(text(resultFile))).toBe(124);
        expect(running(bystander.pid)).toBe(true);
      } finally {
        if (!ended) {
          stopOwned(proc.pid);
          await proc.exited;
        }
        if (existsSync(childFile) && running(Number(text(childFile))))
          process.kill(Number(text(childFile)), 'SIGKILL');
        bystander.kill();
        await bystander.exited;
      }
    }, 10_000);
  }

  test('preserves an ordinary exit code and reports a real overrun as 124', async () => {
    const bed = machineBed(join(scratch, 'status'), 0);
    const helper = bed.gate.replace('machine-gate.sh', 'machine-process.sh');
    const proc = Bun.spawn(
      [
        'bash',
        '-c',
        'source "$1"; rc=0; bounded 2 bash -c "echo expected-output; exit 7" || rc=$?; echo status=$rc; rc=0; bounded 1 sleep 30 || rc=$?; echo timeout=$rc',
        '_',
        helper,
      ],
      { env: env(bed), stdout: 'pipe', stderr: 'pipe' }
    );
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe('expected-output\nstatus=7\ntimeout=124\n');
  }, 10_000);
});
