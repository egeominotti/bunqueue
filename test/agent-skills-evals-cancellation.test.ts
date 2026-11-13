import { afterAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentSpecs } from '../scripts/agents/skill-eval-agents';
import { evalFixture, fixture } from './agent-skills-tools-audit-support';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('evaluation cancellation and shell path regressions', () => {
  for (const phase of ['version', 'discovery', 'session']) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      test(`${signal} during ${phase} stops all later scheduling and reports interruption`, async () => {
        const f = evalFixture(`cancel-${phase}`);
        dirs.push(f.dir);
        const child = spawn(
          process.execPath,
          [
            join(f.dir, 'scripts/agents/run-skill-evals.ts'),
            '--agent',
            'codex',
            '--skill',
            'bunqueue-dev',
            '--limit',
            '2',
            '--concurrency',
            '2',
            '--timeout',
            '1',
          ],
          {
            cwd: f.dir,
            env: { ...f.env, SKILL_EVALS_CODEX_BIN: join(f.dir, 'fake-agent') },
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          output += String(chunk);
        });
        const result = new Promise<{ code: number | null; killed: boolean }>((resolve) => {
          let killed = false;
          const watchdog = setTimeout(() => {
            killed = true;
            try {
              process.kill(-child.pid!, 'SIGKILL');
            } catch {
              /* Already exited. */
            }
          }, 4000);
          child.on('close', (code) => {
            clearTimeout(watchdog);
            resolve({ code, killed });
          });
        });
        const wanted = phase === 'version' ? '--version' : phase === 'discovery' ? 'debug' : 'exec';
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          if (
            existsSync(join(f.dir, 'calls')) &&
            f.calls().filter((a) => a[0] === wanted).length >= (phase === 'session' ? 2 : 1)
          )
            break;
          await Bun.sleep(5);
        }
        expect(f.calls().filter((a) => a[0] === wanted)).toHaveLength(phase === 'session' ? 2 : 1);
        child.kill(signal);
        const done = await result;
        expect({ killed: done.killed, output: done.killed ? output : '' }).toEqual({
          killed: false,
          output: '',
        });
        expect(done.code).toBe(signal === 'SIGTERM' ? 143 : 130);
        expect(f.calls().filter((a) => a[0] === 'exec')).toHaveLength(phase === 'session' ? 2 : 0);
        expect(f.calls().map((a) => a[0])).toEqual(
          phase === 'version'
            ? ['--version']
            : phase === 'discovery'
              ? ['--version', 'debug']
              : ['--version', 'debug', 'exec', 'exec']
        );
        expect(f.report().interrupted).toBe(signal);
        expect(f.report().outcomes.map((o) => o.status)).toEqual(
          phase === 'session' ? ['interrupted', 'interrupted'] : []
        );
        expect(f.report().summary[0]?.shouldTrigger.total).toBe(0);
        expect(f.report().summary[0]?.shouldNot.total).toBe(0);
        if (existsSync(join(f.dir, 'heartbeat'))) {
          const before = readFileSync(join(f.dir, 'heartbeat'), 'utf8');
          await Bun.sleep(100);
          expect(readFileSync(join(f.dir, 'heartbeat'), 'utf8')).toBe(before);
        }
      });
    }
  }

  for (const dirname of ["apostrophe'root", 'space root']) {
    test(`canonical ${dirname} paths support discovery and shell quoting`, () => {
      const f = fixture();
      dirs.push(f.dir);
      const root = join(f.dir, dirname);
      const file = join(root, '.agents/skills/demo/SKILL.md');
      mkdirSync(join(root, '.agents/skills/demo'), { recursive: true });
      writeFileSync(file, 'demo');
      const spec = agentSpecs(root, 2).codex!;
      expect(spec.discovery.names(`- demo: description (file: ${file})`)).toEqual(['demo']);
      const shellSingle = `'${file.replaceAll("'", `'\\''`)}'`;
      const shellEscaped = file.replace(/[ '\\]/g, '\\$&');
      for (const path of [JSON.stringify(file), shellSingle, shellEscaped]) {
        expect(
          spec.loaded({
            type: 'item.completed',
            item: {
              type: 'command_execution',
              status: 'completed',
              exit_code: 0,
              command: `cat ${path}`,
            },
          })
        ).toEqual(['demo']);
      }
    });
  }
});
