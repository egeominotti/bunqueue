import { afterAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './agent-harness-support';
import { running } from './agent-skills-fakes';
import { bounded, executable, fixture, WATCH } from './agent-skills-tools-audit-support';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('CI watcher direct-PID cancellation', () => {
  for (const phase of ['query', 'history']) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      test(`${signal} during hung ${phase} promptly cleans the owned CLI group`, async () => {
        const f = fixture();
        dirs.push(f.dir);
        executable(
          join(f.bin, 'gh'),
          `#!/bin/bash
if [ '${phase}' = history ]; then
  case "$*" in *--attempt*) ;; *) echo 'completed|success|2|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|https://example.invalid/1|CI'; exit 0;; esac
fi
echo $$ > '${join(f.dir, 'gh.pid')}'
trap '' TERM INT
while :; do printf x >> '${join(f.dir, 'heartbeat')}'; sleep 0.02; done
`
        );
        const child = spawn('bash', [WATCH, '--run', '1', '--timeout', '30'], {
          cwd: f.dir,
          env: f.env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const bystander = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
        let stdout = '',
          stderr = '',
          killed = false;
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        const result = new Promise<number | null>((resolve) => {
          const watchdog = setTimeout(() => {
            killed = true;
            try {
              process.kill(-child.pid!, 'SIGKILL');
            } catch {
              /* Already exited. */
            }
          }, 1500);
          child.on('close', (code) => {
            clearTimeout(watchdog);
            resolve(code);
          });
        });
        let code: number | null;
        const deadline = Date.now() + 1000;
        while (!existsSync(join(f.dir, 'heartbeat')) && Date.now() < deadline) await Bun.sleep(5);
        expect(existsSync(join(f.dir, 'heartbeat'))).toBe(true);
        const interruptedAt = Date.now();
        child.kill(signal);
        try {
          code = await result;
          expect({ killed, stderr: killed ? stderr : '' }).toEqual({ killed: false, stderr: '' });
          expect(code).toBe(4);
          expect(stdout).toContain('NO VERDICT  interrupted');
          expect(Date.now() - interruptedAt).toBeLessThan(900);
          const cliRunningAtReturn = running(Number(readFileSync(join(f.dir, 'gh.pid'), 'utf8')));
          const before = readFileSync(join(f.dir, 'heartbeat'), 'utf8');
          await Bun.sleep(100);
          expect(readFileSync(join(f.dir, 'heartbeat'), 'utf8')).toBe(before);
          expect(cliRunningAtReturn).toBe(false);
          expect(bystander.exitCode).toBeNull();
        } finally {
          bystander.kill('SIGKILL');
          await bystander.exited;
          // The red implementation leaves a detached gh group. Only signal the
          // PID recorded by this fixture's gh, never a name-based process search.
          const pid = Number(readFileSync(join(f.dir, 'gh.pid'), 'utf8'));
          if (Number.isSafeInteger(pid) && pid > 1) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              /* Already cleaned. */
            }
          }
        }
      });
    }
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'AbortSignal'] as const) {
    test(`${signal} while spawn has not returned still cleans the owned CLI`, async () => {
      const f = fixture();
      dirs.push(f.dir);
      // Copy the actual helper, replacing only its spawn import with a boundary
      // adapter that delivers the signal before exposing the OS child to JS.
      const source = readFileSync(join(ROOT, 'scripts/agents/skill-eval-process.ts'), 'utf8');
      expect(source).toContain("from 'node:child_process'");
      writeFileSync(
        join(f.dir, 'process.ts'),
        source.replace("from 'node:child_process'", "from './ci-cancel-startup-spawn'")
      );
      cpSync(
        join(ROOT, 'test/support/ci-cancel-startup-spawn.ts'),
        join(f.dir, 'ci-cancel-startup-spawn.ts')
      );
      executable(
        join(f.bin, 'gh'),
        `#!/bin/bash
echo $$ > '${join(f.dir, 'gh.pid')}'
trap '' TERM INT
while :; do printf x >> '${join(f.dir, 'heartbeat')}'; sleep 0.02; done
`
      );
      const code = `import {runCommand} from './process';import {getEventListeners} from 'node:events';const controller=new AbortController();${signal === 'AbortSignal' ? 'globalThis.__ciSpawnAbort=()=>controller.abort();' : ''}const result=await runCommand(['gh'],{cwd:process.cwd(),env:process.env,timeoutMs:30000,${signal === 'AbortSignal' ? 'signal:controller.signal' : ''}});console.log(JSON.stringify({...result,abortListeners:getEventListeners(controller.signal,'abort').length}));`;
      const proc = spawn(process.execPath, ['-e', code], {
        cwd: f.dir,
        env: {
          ...f.env,
          BUNQUEUE_CI_STARTUP_HEARTBEAT: join(f.dir, 'heartbeat'),
          BUNQUEUE_CI_STARTUP_SIGNAL: signal,
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const bystander = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
      let out = '';
      proc.stdout.on('data', (chunk) => {
        out += String(chunk);
      });
      proc.stderr.on('data', () => {});
      const result = new Promise<number | null>((resolve) => {
        const watchdog = setTimeout(() => {
          try {
            process.kill(-proc.pid!, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
        }, 1500);
        proc.on('close', (status) => {
          clearTimeout(watchdog);
          resolve(status);
        });
      });
      try {
        expect(await result).toBe(0);
        expect(JSON.parse(out).interrupted).toBe(true);
        expect(JSON.parse(out).abortListeners).toBe(0);
        expect(running(Number(readFileSync(join(f.dir, 'gh.pid'), 'utf8')))).toBe(false);
        const before = readFileSync(join(f.dir, 'heartbeat'), 'utf8');
        await Bun.sleep(100);
        expect(readFileSync(join(f.dir, 'heartbeat'), 'utf8')).toBe(before);
        expect(bystander.exitCode).toBeNull();
      } finally {
        bystander.kill('SIGKILL');
        await bystander.exited;
        if (existsSync(join(f.dir, 'gh.pid'))) {
          const pid = Number(readFileSync(join(f.dir, 'gh.pid'), 'utf8'));
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* Already cleaned. */
          }
        }
      }
    });
  }
  test('pre-aborted requests and spawn errors release cancellation listeners and timers', async () => {
    const code = `import {runCommand} from './scripts/agents/skill-eval-process';import {getEventListeners} from 'node:events';
const before=['SIGTERM','SIGINT'].map(s=>process.listenerCount(s));
const controller=new AbortController();let errors=0;
for(const signal of [undefined,controller.signal]) for(const command of [[],['/bunqueue-nonexistent-ci-executable']]) {
 try {await runCommand(command,{cwd:process.cwd(),timeoutMs:30000,signal});}catch{errors++;}
}
controller.abort();const aborted=await runCommand(['/bunqueue-nonexistent-ci-executable'],{cwd:process.cwd(),timeoutMs:30000,signal:controller.signal});
console.log(JSON.stringify({before,after:['SIGTERM','SIGINT'].map(s=>process.listenerCount(s)),errors,aborted:aborted.interrupted,abortListeners:getEventListeners(controller.signal,'abort').length}));`;
    const result = await bounded([process.execPath, '-e', code], ROOT, process.env, 1500);
    expect({ code: result.code, killed: result.killed }).toEqual({ code: 0, killed: false });
    const data = JSON.parse(result.stdout);
    expect(data.errors).toBe(4);
    expect(data.aborted).toBe(true);
    expect(data.after).toEqual(data.before);
    expect(data.abortListeners).toBe(0);
  });
});
