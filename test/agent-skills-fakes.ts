/**
 * Fixtures and fake commands for the Machine gate tests
 * (`test/agent-skills-machine-gate.test.ts`, docs/agents/README.md#skills): bun-style
 * logs, finished Machine directories, a fake OrbStack (`orb`) whose daemon can finish
 * a create after its CLI is killed, fake `git`, `ssh`, `rsync` and `uname`, and a
 * portable process table to prove that no worker outlives the gate.
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './agent-harness-support';
import { SKILLS_DIR } from './agent-skills-support';

export const MACHINE_SKILL = `${SKILLS_DIR}/bunqueue-running-machine-gates`;
export const ALL_STEPS = ['unit', 'tcp', 'embedded', 'typecheck', 'format', 'tinyfs'];

/** `[file, title]` pairs of the known gap (assets/known-node-gap.txt). */
export function knownGap(): [string, string][] {
  const text = readFileSync(join(ROOT, MACHINE_SKILL, 'assets/known-node-gap.txt'), 'utf8');
  return [...text.matchAll(/^test (\S+) (.+)$/gm)].map((match) => [match[1]!, match[2]!]);
}

/** A bun test log: each file's header, its `(fail)` lines, the recap, the summary. */
export function bunLog(failed: readonly [string, string][], passed: number, extra = ''): string {
  const lines: string[] = [];
  for (const file of [...new Set(failed.map(([file]) => file))]) {
    lines.push('', `${file}:`, '(pass) a passing neighbour [0.10ms]');
    for (const [, title] of failed.filter(([owner]) => owner === file)) {
      lines.push('error: bash: line 2: node: command not found', `(fail) ${title} [1.22ms]`);
    }
  }
  if (failed.length)
    lines.push(
      '',
      `${failed.length} tests failed:`,
      ...failed.map(([, t]) => `(fail) ${t} [1.22ms]`)
    );
  const total = passed + failed.length;
  return `${lines.join('\n')}\n${extra}\n ${passed} pass\n 3 skip\n ${failed.length} fail\nRan ${total} tests across 9 files. [5.00s]\n`;
}

/** One finished Machine directory as machine-steps.sh leaves it. */
export function writeMachine(
  dir: string,
  steps: Record<string, number>,
  logs: Record<string, string>
) {
  mkdirSync(dir, { recursive: true });
  const rows = Object.entries(steps).map(([step, code]) => `${step}\t${code}\t1\t-\t-\tcmd`);
  writeFileSync(
    join(dir, 'steps.tsv'),
    `step\texit\tseconds\tstart_utc\tend_utc\tcommand\n${rows.join('\n')}\n`
  );
  writeFileSync(join(dir, 'environment.txt'), 'os: Test Linux\narch: aarch64\nnode: absent\n');
  for (const [step, text] of Object.entries(logs)) writeFileSync(join(dir, `${step}.log`), text);
  writeFileSync(join(dir, 'DONE'), '');
}

/** Every step at `code`, plus install and build-client at 0. */
export function steps(code: Record<string, number> = {}): Record<string, number> {
  return Object.fromEntries(
    ['install', 'build-client', ...ALL_STEPS].map((step) => [step, code[step] ?? 0])
  );
}

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
};

export interface Bed {
  /** The gate inside a scratch repository that holds only the Machine skill. */
  gate: string;
  repo: string;
  orb: string;
  env: Record<string, string>;
  machines: () => string[];
  deleted: () => string[];
  /** Every `orb` invocation so far, one per line. */
  calls: () => string;
}

/** A scratch repository plus fake orb, ssh, rsync, git and uname (Darwin) on PATH. */
export function machineBed(dir: string, createSleep: number, daemonDelay = 1): Bed {
  const repo = join(dir, 'repo');
  const orb = join(dir, 'orb');
  const fakes = join(dir, 'fakes');
  const snapshot = join(dir, 'snapshot');
  for (const path of [fakes, join(orb, 'machines'), join(snapshot, '.github/workflows')]) {
    mkdirSync(path, { recursive: true });
  }
  cpSync(join(ROOT, MACHINE_SKILL), join(repo, MACHINE_SKILL), { recursive: true });
  writeFileSync(join(snapshot, '.github/workflows/ci.yml'), "env:\n  BUN_VERSION: '1.4.4'\n");
  writeFileSync(join(snapshot, 'README.md'), 'fixture\n');
  const uname = Bun.which('uname') ?? '/usr/bin/uname';
  script(
    join(fakes, 'uname'),
    `if [ "\${1:-}" = -s ]; then echo Darwin; else exec ${uname} "$@"; fi\n`
  );
  script(
    join(fakes, 'git'),
    `[ "$1" = -C ] && shift 2
case "$1" in
  write-tree) echo 1111111111111111111111111111111111111111 ;;
  rev-parse) case "$*" in *--git-dir*) echo .git ;; *--short*) echo abc1234 ;; *) echo 1111111111111111111111111111111111111111 ;; esac ;;
  archive) tar -c -C "${snapshot}" . ;;
  *) exit 0 ;;
esac\n`
  );
  // Files in the state directory switch behaviours: `list-slow` keeps writing after the
  // first names (a reader that stops early breaks the pipe), `list-fail-from` holds the
  // number of the first `orb list` call that fails.
  script(
    join(fakes, 'orb'),
    `state="${orb}"
echo "$*" >> "$state/calls"
case "$1" in
  list) count=$(($(cat "$state/list-count" 2>/dev/null || echo 0) + 1)); echo $count > "$state/list-count"
    [ ! -e "$state/list-fail-from" ] || [ $count -lt "$(cat "$state/list-fail-from")" ] || exit 1
    ls "$state/machines"
    if [ -e "$state/list-slow" ]; then sleep 1; echo zz-another-machine || exit 141; fi ;;
  version) echo 'Version: fake' ;;
  info) [ -e "$state/machines/$4" ] || exit 1
    printf '{\\n  "record": {\\n    "name": "%s",\\n    "config": {\\n      "isolated": true,\\n      "forward_ssh_agent": false,\\n      "isolate_network": true\\n    }\\n  }\\n}\\n' "$4" ;;
  create) for name; do :; done
    if [ ${createSleep} -gt 0 ]; then
      ( ( sleep ${daemonDelay}; touch "$state/machines/$name" ) & )
      touch "$state/started-$name"
      sleep ${createSleep}
    else touch "$state/machines/$name" "$state/started-$name"; fi ;;
  delete) shift; [ "$1" = -f ] && shift
    for name; do rm -f "$state/machines/$name"; echo "$name" >> "$state/deleted"; done ;;
esac\n`
  );
  script(join(fakes, 'ssh'), 'for last; do :; done\n[ "$last" = true ] && exit 0\nexit 1\n');
  script(join(fakes, 'rsync'), 'exit 1\n');
  const list = (path: string) => (existsSync(path) ? readdirSync(path).sort() : []);
  return {
    gate: join(repo, MACHINE_SKILL, 'scripts/machine-gate.sh'),
    repo,
    orb,
    env: { PATH: `${fakes}:${process.env.PATH}` },
    machines: () => list(join(orb, 'machines')),
    calls: () => (existsSync(join(orb, 'calls')) ? readFileSync(join(orb, 'calls'), 'utf8') : ''),
    deleted: () =>
      existsSync(join(orb, 'deleted'))
        ? readFileSync(join(orb, 'deleted'), 'utf8').trim().split('\n').sort()
        : [],
  };
}

/** pid -> [parent pid, state] for every process (Linux /proc, otherwise ps). */
function processTable(): Map<number, [number, string]> {
  const table = new Map<number, [number, string]>();
  if (existsSync('/proc/self/stat')) {
    for (const entry of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
      try {
        const fields = readFileSync(`/proc/${entry}/stat`, 'utf8')
          .replace(/^.*\) /s, '')
          .split(' ');
        table.set(Number(entry), [Number(fields[1]), fields[0]!]);
      } catch {
        // The process exited while the table was read.
      }
    }
    return table;
  }
  const ps = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=,stat=']).stdout.toString();
  for (const line of ps.trim().split('\n')) {
    const [pid, ppid, state] = line.trim().split(/\s+/);
    table.set(Number(pid), [Number(ppid), state ?? '']);
  }
  return table;
}

/** Every live descendant of `pid`. */
export function descendants(pid: number): number[] {
  const table = processTable();
  const found: number[] = [];
  const queue = [pid];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const [child, [ppid]] of table) {
      if (ppid !== parent || found.includes(child)) continue;
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** Whether `pid` still runs (a zombie does not). */
export function running(pid: number): boolean {
  const entry = processTable().get(pid);
  return entry !== undefined && !entry[1].startsWith('Z');
}
