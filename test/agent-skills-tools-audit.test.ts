import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '../scripts/agents/skill-eval-process';
import {
  bounded,
  evalFixture,
  executable,
  fixture,
  WATCH,
} from './agent-skills-tools-audit-support';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const track = <T extends { dir: string }>(f: T): T => {
  dirs.push(f.dir);
  return f;
};

describe('CI wall-clock and verdict audit regressions', () => {
  test('a shared one-second budget does not expire at the next wall-clock second', async () => {
    const f = track(fixture());
    executable(
      join(f.bin, 'gh'),
      `#!/bin/bash
case "$*" in
  'run list '*) sleep 0.3; echo 1;;
  *) trap '' TERM; sleep 30;;
esac
`
    );
    // Cross the wall-clock second in the first query. Bash SECONDS rounds this
    // to a full elapsed second even though most of the budget remains.
    await Bun.sleep((850 - (Date.now() % 1000) + 1000) % 1000);
    const r = await bounded(
      ['bash', WATCH, '--sha', 'a'.repeat(40), '--timeout', '1'],
      f.dir,
      f.env
    );
    expect({ killed: r.killed, code: r.code }).toEqual({ killed: false, code: 4 });
    expect(r.ms).toBeGreaterThanOrEqual(900);
    expect(r.ms).toBeLessThan(2000);
  });
  for (const mode of ['hung', 'slow', 'history', 'retry']) {
    test(`--timeout bounds ${mode} gh calls and retry/history waits`, async () => {
      const f = track(fixture());
      executable(
        join(f.bin, 'gh'),
        `#!/bin/bash
if [ '${mode}' = hung ]; then trap '' TERM; sleep 30; fi
if [ '${mode}' = slow ]; then sleep 2; fi
if [ '${mode}' = retry ]; then exit 1; fi
case "$*" in *--attempt*) trap '' TERM; sleep 30;; esac
echo 'completed|success|${mode === 'history' ? '2' : '1'}|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|https://example.invalid/1|CI'
`
      );
      const r = await bounded(
        ['bash', WATCH, '--run', '1', '--timeout', '1', '--interval', '30'],
        f.dir,
        { ...f.env, BUNQUEUE_CI_WATCH_PAUSE_SECONDS: '30' }
      );
      expect({ killed: r.killed, code: r.code }).toEqual({ killed: false, code: 4 });
      expect(r.ms).toBeLessThan(2500);
    });
  }
  test('conclusive FAILED outranks unavailable rerun history', async () => {
    const f = track(fixture());
    executable(
      join(f.bin, 'gh'),
      `#!/bin/bash
case "$*" in
  'run list '*) printf '1\\n2\\n';;
  *--attempt*) case "$*" in *'view 2 '*) exit 1;; *) echo 'Unit (failure)';; esac;;
  *'view 1 '*) echo 'completed|failure|1|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|https://example.invalid/1|CI';;
  *) echo 'completed|success|2|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|https://example.invalid/2|CI';;
esac
`
    );
    const r = await bounded(
      ['bash', WATCH, '--sha', 'a'.repeat(40), '--timeout', '1'],
      f.dir,
      f.env
    );
    expect(r.killed).toBe(false);
    expect(r.stdout).toContain('FAILED');
    expect(r.code).toBe(1);
  });
});

describe('evaluation discovery, attribution and process audit regressions', () => {
  test('an exited CLI cannot leave silent owned descendants running', async () => {
    const f = track(fixture());
    const heartbeat = join(f.dir, 'heartbeat');
    const childCode = `import {appendFileSync} from 'node:fs';process.on('SIGTERM',()=>{});appendFileSync(${JSON.stringify(heartbeat)},'x');setInterval(()=>appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`;
    const code = `import {existsSync} from 'node:fs';Bun.spawn([process.execPath,'-e',${JSON.stringify(childCode)}],{stdout:'ignore',stderr:'ignore'});while(!existsSync(${JSON.stringify(heartbeat)}))await Bun.sleep(5);process.exit(0)`;
    await runCommand([process.execPath, '-e', code], { cwd: f.dir, timeoutMs: 1000 });
    const before = readFileSync(heartbeat, 'utf8');
    await Bun.sleep(100);
    expect(readFileSync(heartbeat, 'utf8')).toBe(before);
    expect(existsSync(heartbeat)).toBe(true);
  });
  for (const mode of ['missing-discovery', 'stale-discovery', 'failed-discovery']) {
    test(`${mode} starts zero paid sessions`, async () => {
      const f = track(evalFixture(mode));
      const r = await f.run();
      expect(r.killed).toBe(false);
      expect(r.code).toBe(1);
      expect(f.calls().filter((args) => args[0] === 'exec')).toEqual([]);
      expect(f.report().outcomes).toEqual([]);
    });
  }
  for (const mode of ['stale-read', 'failed-read', 'started-read']) {
    test(`${mode} never scores a skill as loaded`, async () => {
      const f = track(evalFixture(mode));
      const r = await f.run();
      expect({ code: r.code, killed: r.killed }).toEqual({ code: 0, killed: false });
      expect(f.report().outcomes.map((o) => o.loaded)).toEqual([[], []]);
      expect(f.report().summary[0]?.shouldTrigger.hit).toBe(0);
    });
  }
  test('a completed successful canonical read is scored; explicit-only absence is allowed', async () => {
    const f = track(evalFixture('valid'));
    const r = await f.run();
    expect(r.code).toBe(0);
    expect(f.report().outcomes.map((o) => o.loaded)).toEqual([['bunqueue-dev'], ['bunqueue-dev']]);
    expect(f.report().discovery.missing).toEqual(['explicit-only']);
  });
  for (const mode of ['ignore-term', 'descendant']) {
    test(`timeout cleans owned ${mode} CLI trees without hanging`, async () => {
      const f = track(evalFixture(mode));
      const unrelated = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const r = await f.run().finally(async () => {
        expect(unrelated.exitCode).toBeNull();
        unrelated.kill('SIGKILL');
        await unrelated.exited;
      });
      expect(r.killed).toBe(false);
      expect(f.report().outcomes.map((o) => o.status)).toEqual(['timeout', 'timeout']);
      const before = readFileSync(join(f.dir, 'heartbeat'), 'utf8');
      expect(before.length).toBeGreaterThan(0);
      await Bun.sleep(100);
      expect(readFileSync(join(f.dir, 'heartbeat'), 'utf8')).toBe(before);
    });
  }
});
