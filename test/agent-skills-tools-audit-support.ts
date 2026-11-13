import { spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './agent-harness-support';

export const WATCH = join(ROOT, '.agents/skills/bunqueue-running-gates/scripts/ci-watch.sh');
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bunqueue-tools-audit-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  return {
    dir,
    bin,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BUNQUEUE_CI_WATCH_PAUSE_SECONDS: '0.01',
    },
  };
}
export function executable(path: string, source: string) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}
/** The watchdog only signals a new process group created for this fixture. */
export function bounded(args: string[], cwd: string, env: NodeJS.ProcessEnv, cap = 3500) {
  return new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    killed: boolean;
    ms: number;
  }>((resolve, reject) => {
    const started = Date.now();
    const child = spawn(args[0]!, args.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      killed = false;
    child.stdout.on('data', (data) => {
      stdout += String(data);
    });
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    const timer = setTimeout(() => {
      killed = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }, cap);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, killed, ms: Date.now() - started });
    });
  });
}

export function evalFixture(mode: string) {
  const f = fixture();
  mkdirSync(join(f.dir, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'scripts/agents'), join(f.dir, 'scripts/agents'), { recursive: true });
  for (const skill of ['bunqueue-dev', 'explicit-only']) {
    const base = join(f.dir, '.agents/skills', skill);
    mkdirSync(join(base, 'evals'), { recursive: true });
    writeFileSync(
      join(base, 'SKILL.md'),
      '---\nname: ' + skill + '\ndescription: "Use when testing."\n---\n'
    );
    writeFileSync(
      join(base, 'evals/evals.json'),
      JSON.stringify({
        trigger_queries: [
          { query: 'positive', should_trigger: true },
          { query: 'negative', should_trigger: false },
          ...(mode.startsWith('cancel-')
            ? [
                { query: 'positive2', should_trigger: true },
                { query: 'negative2', should_trigger: false },
              ]
            : []),
        ],
      })
    );
    if (skill === 'explicit-only') {
      mkdirSync(join(base, 'agents'));
      writeFileSync(
        join(base, 'agents/openai.yaml'),
        'policy:\n  allow_implicit_invocation: false\n'
      );
    }
  }
  executable(join(f.bin, 'git'), '#!/bin/sh\nexit 0\n');
  const agent = join(f.dir, 'fake-agent');
  executable(
    agent,
    `#!${process.execPath}
import { appendFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = import.meta.dir, mode = ${JSON.stringify(mode)}, args = process.argv.slice(2);
appendFileSync(join(root, 'calls'), JSON.stringify(args) + '\\n');
if ((mode === 'cancel-version' && args[0] === '--version') ||
    (mode === 'cancel-discovery' && args[0] === 'debug') ||
    (mode === 'cancel-session' && args[0] === 'exec')) {
  process.on('SIGTERM', () => {}); process.on('SIGINT', () => {});
  setTimeout(() => process.exit(99), 5000);
  setInterval(() => appendFileSync(join(root, 'heartbeat'), 'x'), 20);
  const childCode = "import {appendFileSync} from 'node:fs';process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setTimeout(()=>process.exit(99),5000);setInterval(()=>appendFileSync(" + JSON.stringify(join(root, 'heartbeat')) + ",'y'),20)";
  Bun.spawn([process.execPath, '-e', childCode], {stdout:'inherit',stderr:'inherit'});
  await new Promise(() => {});
}
if (args[0] === '--version') {
  console.log('fake 1');
  if (mode === 'missing-discovery-launch') unlinkSync(join(root, 'fake-agent'));
  process.exit(0);
}
if (args[0] === 'debug') {
  if (mode !== 'missing-discovery') for (const name of readdirSync(join(root, '.agents/skills'))) {
    if (mode !== 'valid' || name !== 'explicit-only') console.log((mode === 'stale-discovery' ? '/old-copy/' : root + '/.agents/skills/') + name + '/SKILL.md');
  }
  process.exit(mode === 'failed-discovery' ? 1 : 0);
}
if (mode === 'ignore-term' || mode === 'descendant') {
  process.on('SIGTERM', () => {});
  if (mode === 'descendant') {
    const childCode = "import {appendFileSync} from 'node:fs';process.on('SIGTERM',()=>{});setInterval(()=>appendFileSync(" + JSON.stringify(join(root, 'heartbeat')) + ",'x'),20)";
    const child = Bun.spawn([process.execPath, '-e', childCode], {stdout:'inherit',stderr:'inherit'});
    writeFileSync(join(root, 'descendant.pid'), String(child.pid));
    process.exit(0);
  }
  setInterval(() => appendFileSync(join(root, 'heartbeat'), 'x'), 20);
} else {
  const command = 'cat ' + (mode === 'stale-read' ? '/old-copy/' : root + '/.agents/skills/') + 'bunqueue-dev/SKILL.md';
  console.log(JSON.stringify({type: mode === 'started-read' ? 'item.started' : 'item.completed', item:{ type:'command_execution', command, status:mode === 'failed-read' ? 'failed' : 'completed', exit_code: mode === 'failed-read' ? 1 : 0 }}));
  console.log(JSON.stringify({type:'turn.completed'}));
  if (mode === 'missing-session-launch') unlinkSync(join(root, 'fake-agent'));
}
`
  );
  const run = () =>
    bounded(
      [
        process.execPath,
        join(f.dir, 'scripts/agents/run-skill-evals.ts'),
        '--agent',
        'codex',
        '--skill',
        'bunqueue-dev',
        '--limit',
        '1',
        '--concurrency',
        '1',
        '--timeout',
        '1',
      ],
      f.dir,
      { ...f.env, SKILL_EVALS_CODEX_BIN: agent }
    );
  const calls = () =>
    readFileSync(join(f.dir, 'calls'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
  const report = () => {
    const base = join(f.dir, 'artifacts/skill-evals');
    const name = readdirSync(base).sort().at(-1)!;
    return JSON.parse(readFileSync(join(base, name, 'report.json'), 'utf8')) as {
      outcomes: { loaded: string[]; status: string; log: string }[];
      discovery: { missing: string[]; valid: boolean };
      summary: {
        shouldTrigger: { hit: number; total: number };
        shouldNot: { fired: number; total: number };
        errors: number;
      }[];
      interrupted?: string | null;
      launchErrors?: { command: string; error: string }[];
    };
  };
  return { ...f, run, calls, report };
}
