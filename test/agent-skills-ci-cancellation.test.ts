import { afterAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { executable, fixture, WATCH } from './agent-skills-tools-audit-support';

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
          const before = readFileSync(join(f.dir, 'heartbeat'), 'utf8');
          await Bun.sleep(100);
          expect(readFileSync(join(f.dir, 'heartbeat'), 'utf8')).toBe(before);
        } finally {
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
});
