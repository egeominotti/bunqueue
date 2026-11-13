/** Fake-tool fixtures for the Machine lifecycle regressions; no OrbStack is invoked. */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Bed, descendants, machineBed, MACHINE_SKILL } from './agent-skills-fakes';

export const text = (path: string) => readFileSync(path, 'utf8');
export function fake(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
}
export const env = (bed: Bed, extra = {}) => ({ ...process.env, ...bed.env, ...extra });
export const runDir = (bed: Bed, id: string) => join(bed.repo, 'artifacts/machines', id);
export async function until(check: () => boolean) {
  for (let n = 0; n < 200 && !check(); n++) await Bun.sleep(25);
  if (!check()) throw new Error('fake tool readiness timed out');
}
export function stopOwned(pid: number) {
  for (const child of descendants(pid).reverse().concat(pid)) {
    try {
      process.kill(child, 'SIGKILL');
    } catch {
      /* Already exited. */
    }
  }
}
export function workerBed(dir: string, name: string, createSleep = 0) {
  const bed = machineBed(dir, createSleep);
  const state = join(dir, 'state');
  mkdirSync(state);
  const args = [
    'bash',
    bed.gate.replace('machine-gate.sh', 'machine-worker.sh'),
    '--distro',
    'ubuntu:24.04',
    '--name',
    name,
    '--arch',
    'arm64',
    '--run-dir',
    join(dir, 'run'),
    '--state-dir',
    state,
    '--snapshot',
    join(dir, 'snapshot'),
    '--content-hash',
    'x',
    '--bun-version',
    '1.4.4',
    '--steps',
    'unit,tcp',
  ];
  return { bed, state, args, out: join(dir, 'run', name) };
}
/** A finished remote run; copy-back may succeed, partially fail, or omit a log. */
export function finishedBed(
  dir: string,
  copy: 'complete' | 'partial' | 'missing' | 'runner' | 'runner-missing'
) {
  const bed = machineBed(dir, 0);
  const hash = Bun.spawnSync([
    'bash',
    join(bed.repo, MACHINE_SKILL, 'scripts/machine-steps.sh'),
    '--content-hash',
    join(dir, 'snapshot'),
  ])
    .stdout.toString()
    .trim();
  fake(
    join(dir, 'fakes/ssh'),
    `case "$*" in *--content-hash*) echo '${hash}' ;; *gate-out/DONE*) echo done ;; esac\nexit 0\n`
  );
  const rows = [
    'install',
    'build-client',
    'unit',
    'tcp',
    'embedded',
    'typecheck',
    'format',
    'tinyfs',
  ]
    .map((s) => `${s}\t0\t1\t-\t-\tcmd`)
    .join('\n');
  fake(
    join(dir, 'fakes/rsync'),
    `src=''
for arg; do case "$arg" in *@orb:gate-out/) src=out ;; *@orb:gate-runner.log) src=runner ;; esac; last=$arg; done
case "$src" in
 out) mkdir -p "$last"; printf 'step\\texit\\tseconds\\tstart_utc\\tend_utc\\tcommand\\n' > "$last/steps.tsv"
 cat >> "$last/steps.tsv" <<'ROWS'
${rows}
ROWS
 touch "$last/DONE"; echo 'os: Test Linux' > "$last/environment.txt"
 for step in install build-client unit tcp embedded typecheck format tinyfs; do
   [ '${copy}' != missing ] || [ "$step" != unit ] || continue
   [ '${copy}' != partial ] || continue
   case "$step" in
     unit | tinyfs) printf ' 1 pass\\n 0 fail\\nRan 1 tests across 1 files. [1s]\\n' ;;
     tcp) printf 'Suites: 1/1 passed\\nAssertions: 1/1 passed\\n' ;;
     embedded) printf 'Test Suites: 1/1 passed\\nIndividual Tests: 1/1 passed\\n' ;;
     typecheck) printf 'No type errors in 1 files\\nNo type errors in 1 files\\n' ;;
     format) echo 'All 1 files are formatted' ;;
     *) echo 'successful step' ;;
   esac > "$last/$step.log"
 done
 [ '${copy}' != partial ] || exit 23 ;;
 runner) [ '${copy}' != runner ] || exit 23; [ '${copy}' != runner-missing ] || exit 0; echo done > "$last/gate-runner.log" ;;
esac\n`
  );
  return bed;
}
