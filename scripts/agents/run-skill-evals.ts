#!/usr/bin/env bun
/**
 * Trigger evals for the contributor Agent Skills (docs/agents/skill-evals.md): runs each
 * `trigger_queries` entry of `.agents/skills/<name>/evals/evals.json` in a fresh,
 * read-only, headless session of a real agent CLI, from the repository root, and records
 * the skills that session loaded. Every session spends the owner's subscription: use
 * --limit, and read the cost guard in the docs before a full run.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentSpecs, events, list, rec, type AgentSpec, type Env } from './skill-eval-agents';
import { runCommand } from './skill-eval-process';
type Case = { skill: string; query: string; shouldTrigger: boolean };
/** An `error` session never reached an answer and is excluded from every rate. */
type Outcome = Case & { loaded: string[]; read: string[]; status: string; log: string };

const HELP = `Usage: bun scripts/agents/run-skill-evals.ts [options]

  --agent claude|codex|gemini  agent CLI to drive (default claude)
  --skill <name>               only this skill's queries (repeatable)
  --limit <n>                  at most n should-trigger and n should-not queries per
                               skill; 0 runs the discovery check only
  --concurrency <n>            parallel sessions (default 3)
  --max-turns <n>              Claude Code turn cap per session (default 2)
  --timeout <seconds>          wall-clock cap per session (default 240)
  --dry-run                    print the planned commands, run nothing
  --help                       print this text

SKILL_EVALS_CLAUDE_BIN, SKILL_EVALS_CODEX_BIN and SKILL_EVALS_GEMINI_BIN replace the
launcher, for example "mise exec node@24 -- gemini". Report: artifacts/skill-evals/.`;

const ROOT = resolve(import.meta.dir, '../..');
const SKILLS_DIR = '.agents/skills';

function fail(error?: string): never {
  console[error ? 'error' : 'log'](error ? `${error}\n\n${HELP}` : HELP);
  process.exit(error ? 1 : 0);
}

const opt = { agent: 'claude', skills: [] as string[], limit: Infinity, concurrency: 3 };
const tuning = { maxTurns: 2, timeout: 240, dryRun: false };
const argv = Bun.argv.slice(2);
while (argv.length) {
  const flag = argv.shift()!;
  const value = (): string => argv.shift() ?? fail(`${flag} needs a value`);
  const count = (min: number): number => {
    const n = Number(value());
    return Number.isInteger(n) && n >= min ? n : fail(`${flag} needs an integer >= ${min}`);
  };
  if (flag === '--agent') opt.agent = value();
  else if (flag === '--skill') opt.skills.push(value());
  else if (flag === '--limit') opt.limit = count(0);
  else if (flag === '--concurrency') opt.concurrency = count(1);
  else if (flag === '--max-turns') tuning.maxTurns = count(1);
  else if (flag === '--timeout') tuning.timeout = count(1);
  else if (flag === '--dry-run') tuning.dryRun = true;
  else if (flag === '--help') fail();
  else fail(`unknown option ${flag}`);
}

const spec = agentSpecs(ROOT, tuning.maxTurns)[opt.agent] ?? fail(`unknown agent ${opt.agent}`);
const bin = (Bun.env[`SKILL_EVALS_${opt.agent.toUpperCase()}_BIN`] ?? opt.agent).split(/\s+/);
const known = readdirSync(join(ROOT, SKILLS_DIR))
  .filter((name) => existsSync(join(ROOT, SKILLS_DIR, name, 'SKILL.md')))
  .sort();
for (const name of opt.skills) if (!known.includes(name)) fail(`unknown skill ${name}`);
const selected = opt.skills.length ? known.filter((name) => opt.skills.includes(name)) : known;

const shell = (arg: string): string =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
const command = (args: string[]): string => [...bin, ...args].map(shell).join(' ');
const git = (...args: string[]): string =>
  String(Bun.spawnSync(['git', ...args], { cwd: ROOT }).stdout).trim();
const cancellation = new AbortController();
const launchErrors: { command: string; error: string }[] = [];
let interrupted: 'SIGTERM' | 'SIGINT' | null = null;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    interrupted ??= signal;
    cancellation.abort();
  });
}

async function spawn(args: string[], env: Env = {}, stopAt?: RegExp) {
  try {
    return await runCommand([...bin, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      timeoutMs: tuning.timeout * 1000,
      stopAt,
      signal: cancellation.signal,
    });
  } catch (error) {
    const err = String(error);
    launchErrors.push({ command: command(args), error: err });
    return { code: 125, out: '', err, timedOut: false, interrupted: cancellation.signal.aborted };
  }
}

const cases: Case[] = [];
/** Skills the agent keeps out of implicit invocation (Codex `agents/openai.yaml`). */
const explicitOnly: string[] = [];
const descriptions: Record<string, { chars: number; text: string }> = {};
for (const skill of known) {
  const dir = join(ROOT, SKILLS_DIR, skill);
  const frontmatter = (await Bun.file(join(dir, 'SKILL.md')).text()).split(/^---$/m)[1] ?? '';
  const text = String(rec(Bun.YAML.parse(frontmatter)).description ?? '');
  descriptions[skill] = { chars: text.length, text };
  const yaml = Bun.file(join(dir, 'agents/openai.yaml'));
  const policy = (await yaml.exists()) ? rec(rec(Bun.YAML.parse(await yaml.text())).policy) : {};
  if (opt.agent === 'codex' && policy.allow_implicit_invocation === false) {
    explicitOnly.push(skill);
    continue;
  }
  if (!selected.includes(skill)) continue;
  const queries = list(rec(await Bun.file(join(dir, 'evals/evals.json')).json()).trigger_queries);
  for (const shouldTrigger of [true, false]) {
    const wanted = queries.map(rec).filter((entry) => entry.should_trigger === shouldTrigger);
    for (const entry of wanted.slice(0, opt.limit)) {
      cases.push({ skill, query: String(entry.query), shouldTrigger });
    }
  }
}
const discoveryArgs = spec.discovery.args ?? spec.session('hi');
if (tuning.dryRun) {
  console.log(`# cwd ${ROOT}\n# discovery\n${command(discoveryArgs)}\n# ${cases.length} sessions`);
  for (const item of cases) console.log(command(spec.session(item.query)));
  process.exit(0);
}

const outDir = join(ROOT, 'artifacts/skill-evals', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(join(outDir, 'sessions'), { recursive: true });
const treeBefore = git('status', '--porcelain');
const version = (await spawn(['--version'])).out.trim().split('\n').pop() ?? '';
const discoveryEnv = { ...spec.env, ...spec.discovery.env };
const found = await spawn(discoveryArgs, discoveryEnv, spec.discovery.stopAt);
const names = spec.discovery.names(found.out);
const discovery = {
  command: command(discoveryArgs),
  listed: known.filter((name) => names.includes(name)),
  missing: known.filter((name) => !names.includes(name)),
  explicitOnly,
  valid:
    !cancellation.signal.aborted &&
    !found.timedOut &&
    (found.code === 0 || !!spec.discovery.stopAt?.test(found.out)) &&
    known.every((name) => names.includes(name) || explicitOnly.includes(name)),
};
console.log(`${opt.agent} ${version}: lists ${discovery.listed.length}/${known.length} skills`);
console.log(`  not listed: [${discovery.missing}], explicit-only, not run: [${explicitOnly}]`);

const outcomes: Outcome[] = [];
let next = 0;
let errorsInARow = 0;
async function worker(): Promise<void> {
  while (!cancellation.signal.aborted && next < cases.length && errorsInARow < 5) {
    const index = next++;
    const item = cases[index]!;
    const result = await spawn(spec.session(item.query), spec.env);
    const stream = events(result.out);
    const seen = (pick?: AgentSpec['loaded']): string[] =>
      [...new Set(stream.flatMap(pick ?? (() => [])))].filter((name) => known.includes(name));
    const [loaded, read] = [seen(spec.loaded), seen(spec.read)];
    const done = stream.some(spec.finished);
    const status = result.interrupted
      ? 'interrupted'
      : done
        ? 'ok'
        : result.timedOut
          ? 'timeout'
          : 'error';
    errorsInARow = status === 'error' ? errorsInARow + 1 : 0;
    const log = `sessions/${String(index + 1).padStart(3, '0')}-${item.skill}.jsonl`;
    await Bun.write(join(outDir, log), result.out + (done ? '' : `\n${result.err}`));
    outcomes.push({ ...item, loaded, read, status, log });
    const mark = status === 'error' ? 'ERROR' : loaded.includes(item.skill) ? 'fired' : 'quiet';
    const line = `${item.skill} ${item.shouldTrigger ? 'should' : 'should-not'}: ${mark}`;
    console.log(`${index + 1}/${cases.length} ${line} [${loaded}] read [${read}]`);
  }
}
if (discovery.valid) {
  await Promise.all(Array.from({ length: Math.min(opt.concurrency, cases.length) }, worker));
} else console.error('Stopped: discovery failed; no evaluation sessions started.');
if (errorsInARow >= 5) console.error('Stopped: five sessions in a row failed. Fix the runner.');
outcomes.sort((a, b) => a.log.localeCompare(b.log));
const scored = outcomes.filter((outcome) => !['error', 'interrupted'].includes(outcome.status));
const fired = (outcome: Outcome, skill = outcome.skill): boolean => outcome.loaded.includes(skill);
const summary = selected
  .filter((skill) => !explicitOnly.includes(skill))
  .map((skill) => {
    const own = scored.filter((outcome) => outcome.skill === skill);
    const positive = own.filter((outcome) => outcome.shouldTrigger);
    const negative = own.filter((outcome) => !outcome.shouldTrigger);
    const missed = positive.filter((outcome) => !fired(outcome));
    const readOnly = (rows: Outcome[]): number =>
      rows.filter((outcome) => !fired(outcome) && outcome.read.includes(skill)).length;
    // On a miss: the skills that loaded instead (`none` when no skill loaded).
    const insteadOnMiss: Record<string, number> = {};
    for (const name of missed.flatMap((o) => (o.loaded.length ? o.loaded : ['none']))) {
      insteadOnMiss[name] = (insteadOnMiss[name] ?? 0) + 1;
    }
    return {
      skill,
      shouldTrigger: { hit: positive.length - missed.length, total: positive.length },
      shouldNot: { fired: negative.filter((o) => fired(o)).length, total: negative.length },
      // Not scored: sessions that only opened this skill's SKILL.md as a file.
      readOnly: { shouldTrigger: readOnly(positive), shouldNot: readOnly(negative) },
      insteadOnMiss,
      loadedOnOtherSkillsQueries: scored.filter((o) => o.skill !== skill && fired(o, skill)).length,
      errors: outcomes.filter((o) => o.skill === skill && o.status === 'error').length,
    };
  });
const report = {
  date: new Date().toISOString(),
  agent: opt.agent,
  version,
  head: git('rev-parse', 'HEAD'),
  options: { ...opt, limit: Number.isFinite(opt.limit) ? opt.limit : null, ...tuning },
  sessionCommand: command(spec.session('QUERY')),
  // Sessions are read-only: a change here comes from another process.
  treeChanged: git('status', '--porcelain') !== treeBefore,
  discovery,
  descriptions,
  summary,
  outcomes,
  interrupted,
  launchErrors,
};
await Bun.write(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log('\nskill | should-trigger hit | should-not fired | read only | instead on a miss');
for (const row of summary) {
  const instead = Object.entries(row.insteadOnMiss).map(([name, n]) => `${name} x${n}`);
  const rates = `${row.shouldTrigger.hit}/${row.shouldTrigger.total} | ${row.shouldNot.fired}/${row.shouldNot.total}`;
  const read = `${row.readOnly.shouldTrigger}+${row.readOnly.shouldNot}`;
  console.log(`${row.skill} | ${rates} | ${read} | ${instead.join(', ') || '-'}`);
}
for (const o of scored.filter((outcome) => fired(outcome) !== outcome.shouldTrigger)) {
  const kind = o.shouldTrigger ? 'MISS' : 'FALSE TRIGGER';
  console.log(`${kind} ${o.skill} [${o.loaded}] read [${o.read}] ${o.query}`);
}
const tree = report.treeChanged ? 'changed (by another process)' : 'unchanged';
console.log(`\n${outcomes.length} sessions, working tree ${tree}, ${outDir}/report.json`);
process.exit(
  interrupted === 'SIGTERM'
    ? 143
    : interrupted === 'SIGINT'
      ? 130
      : errorsInARow >= 5 || !discovery.valid || launchErrors.length > 0
        ? 1
        : 0
);
