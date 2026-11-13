/**
 * Agent Skills contract, part 5: `ci-watch.sh`, the CI watcher of the
 * bunqueue-running-gates skill (see docs/agents/README.md#skills).
 *
 * Run: bun test test/agent-skills
 *
 * The script runs here against a fake `gh` that answers `run list` and `run view` from
 * JSON fixtures shaped like GitHub's, through the `--jq` expression the script sends
 * (evaluated by the real `jq`), and records every call:
 * - a green run is exit 0, a failed one exit 1 with its failed jobs and the two
 *   commands to read and rerun it, and a run that is green only after a rerun is
 *   exit 3 with the jobs that failed first;
 * - a cancelled run, a run waiting for an approval, no run, a timeout and a failing
 *   `gh` are exit 4, never a pass;
 * - the script only reads: no call other than `run list` and `run view`.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, read } from './agent-harness-support';
import { type GhBed, ghBed } from './agent-skills-fakes';
import { type Run, SKILLS_DIR, runBash } from './agent-skills-support';

const WATCH = `${SKILLS_DIR}/bunqueue-running-gates/scripts/ci-watch.sh`;
const SHA = '7bc922dbcc1f8f007cf7340a41fec3672a929e40';
const FLAKY_JOB = 'PostgreSQL 16.x Integration Tests';

const scratch = mkdtempSync(join(tmpdir(), 'bunqueue-ci-watch-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let beds = 0;
const bed = (): GhBed => ghBed(join(scratch, `bed-${++beds}`));
const watch = (ci: GhBed, ...args: string[]): Run => runBash(WATCH, args, ci.env);

/** The same without blocking: two bounded waits side by side, or a watch to interrupt. */
function start(ci: GhBed, ...args: string[]) {
  const child = Bun.spawn(['bash', join(ROOT, WATCH), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...ci.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const result = output.then(async ([stdout, stderr]) => ({
    code: await child.exited,
    stdout,
    stderr,
  }));
  return { child, result };
}

const run = (id: number, status: string, conclusion: string | null, attempt = 1) => ({
  status,
  conclusion,
  attempt,
  headSha: SHA,
  url: `https://github.example/actions/runs/${id}`,
  workflowName: 'CI',
});
const jobs = (...entries: [string, string][]) => ({
  jobs: entries.map(([name, conclusion]) => ({ name, conclusion, status: 'completed' })),
});

/** Every call the script made is a read: `gh run list` or `gh run view`. */
function expectReadOnly(calls: string[]) {
  expect(calls.filter((call) => !/^run (?:list|view) /.test(call))).toEqual([]);
}

describe('ci-watch.sh', () => {
  test('jq is installed: the fake gh evaluates the --jq expressions the script sends', () => {
    expect(Bun.which('jq')).not.toBeNull();
    expect(read(WATCH)).toContain('--jq');
  });

  test('a green first attempt is exit 0', () => {
    const ci = bed();
    ci.fixture('run-11.json', run(11, 'completed', 'success'));
    const result = watch(ci, '--run', '11');
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
    expect(result.stdout).toMatch(/^GREEN {7}CI run 11 \(attempt 1, commit 7bc922db\): https:/);
    expectReadOnly(ci.calls());
  });

  test('it polls until the run has finished', () => {
    const ci = bed();
    ci.fixture('run-12.poll-1.json', run(12, 'queued', null));
    ci.fixture('run-12.poll-2.json', run(12, 'in_progress', null));
    ci.fixture('run-12.json', run(12, 'completed', 'success'));
    const result = watch(ci, '--run', '12', '--repo', 'owner/name');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('run 12 is queued');
    expect(result.stderr).toContain('run 12 is in_progress');
    expect(ci.calls().every((call) => call.endsWith('--repo owner/name'))).toBe(true);
  });

  test('green only after a rerun is FLAKY, exit 3, with the jobs that failed first', () => {
    const ci = bed();
    ci.fixture('run-13.json', run(13, 'completed', 'success', 2));
    ci.fixture('run-13-attempt-1.json', jobs(['Unit Tests', 'success'], [FLAKY_JOB, 'failure']));
    const result = watch(ci, '--run', '13');
    expect(result.code).toBe(3);
    expect(result.stdout).toMatch(/^FLAKY {7}CI run 13 \(attempt 2/);
    expect(result.stdout).toContain(`attempt 1: ${FLAKY_JOB} (failure)`);
    expect(result.stdout).toContain('work item');
    expect(result.stdout).not.toContain('Unit Tests');
    expectReadOnly(ci.calls());
  });

  test('a rerun whose first attempt had no failed job is GREEN', () => {
    const ci = bed();
    ci.fixture('run-14.json', run(14, 'completed', 'success', 2));
    ci.fixture('run-14-attempt-1.json', jobs(['Unit Tests', 'cancelled']));
    expect(watch(ci, '--run', '14').code).toBe(0);
  });

  test('a failed run is exit 1 with its failed jobs and how to read and rerun it', () => {
    const ci = bed();
    ci.fixture('run-15.json', run(15, 'completed', 'failure'));
    ci.fixture(
      'run-15-attempt-1.json',
      jobs(
        ['Official SDKs / Python 3.9', 'failure'],
        ['Docs Build', 'timed_out'],
        ['Lint', 'success']
      )
    );
    const result = watch(ci, '--run', '15');
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAILED {6}CI run 15 /);
    expect(result.stdout).toContain('attempt 1: Official SDKs / Python 3.9 (failure)');
    expect(result.stdout).toContain('attempt 1: Docs Build (timed_out)');
    expect(result.stdout).toContain('gh run view 15 --log-failed');
    expect(result.stdout).toContain('gh run rerun 15 --failed');
    expect(result.stdout).not.toContain('Lint');
    expectReadOnly(ci.calls());
  });

  test('a job that fails again on the rerun is reported as not a flake', () => {
    const ci = bed();
    ci.fixture('run-16.json', run(16, 'completed', 'failure', 2));
    ci.fixture('run-16-attempt-1.json', jobs([FLAKY_JOB, 'failure']));
    ci.fixture('run-16-attempt-2.json', jobs([FLAKY_JOB, 'failure']));
    const result = watch(ci, '--run', '16');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`attempt 1: ${FLAKY_JOB} (failure)`);
    expect(result.stdout).toContain(`attempt 2: ${FLAKY_JOB} (failure)`);
    expect(result.stdout).toContain('not as a flake');
    // One rerun is the rule: a second one is not suggested.
    expect(result.stdout).not.toContain('gh run rerun');
  });

  test('--sha watches every run of the workflow for the commit; the worst verdict wins', () => {
    const ci = bed();
    ci.fixture(`list-${SHA}.json`, [{ databaseId: 21 }, { databaseId: 22 }]);
    ci.fixture('run-21.json', run(21, 'completed', 'success'));
    ci.fixture('run-22.json', run(22, 'completed', 'failure'));
    ci.fixture('run-22-attempt-1.json', jobs(['Unit Tests', 'failure']));
    const result = watch(ci, '--sha', SHA);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^GREEN {7}CI run 21 /m);
    expect(result.stdout).toMatch(/^FAILED {6}CI run 22 /m);
    expect(ci.calls()[0]).toContain(`run list --commit ${SHA} --workflow CI`);
    expectReadOnly(ci.calls());
  });

  test('no run for the commit and a run still going at the timeout are exit 4', async () => {
    const none = bed();
    none.fixture(`list-${SHA}.json`, []);
    const slow = bed();
    slow.fixture('run-31.json', run(31, 'in_progress', null));
    const [missing, late] = await Promise.all([
      start(none, '--sha', SHA, '--timeout', '1').result,
      start(slow, '--run', '31', '--timeout', '1').result,
    ]);
    expect(missing.code).toBe(4);
    expect(missing.stdout).toMatch(/^NO VERDICT {2}no result after 1s: no CI run for 7bc922db/);
    expect(late.code).toBe(4);
    expect(late.stdout).toMatch(/^NO VERDICT {2}no result after 1s: run 31 is in_progress/);
    expectReadOnly([...none.calls(), ...slow.calls()]);
  });

  test('a gh that keeps failing is exit 4 after three tries', () => {
    const down = bed();
    down.fixture('outage', '');
    const outage = watch(down, '--run', '32');
    expect(outage.code).toBe(4);
    expect(outage.stdout).toContain('failed 3 times in a row');
    expect(outage.stderr).toContain('simulated outage');
    expect(down.calls()).toHaveLength(3);
  });

  test('an internal error is exit 4, never the exit 1 that means CI failed', () => {
    const ci = bed();
    ci.fixture('run-33.json', run(33, 'in_progress', null));
    const result = runBash(WATCH, ['--run', '33'], {
      ...ci.env,
      BUNQUEUE_CI_WATCH_PAUSE_SECONDS: 'not-a-number',
    });
    expect(result.code).toBe(4);
    expect(result.stdout).toContain('stopped on an internal error');
  });

  test('an interrupt is exit 4: no verdict was reached', async () => {
    const ci = bed();
    ci.fixture('run-34.json', run(34, 'in_progress', null));
    const { child, result } = start(ci, '--run', '34', '--timeout', '60');
    for (let tick = 0; tick < 250 && ci.calls().length < 2; tick++) await Bun.sleep(20);
    child.kill('SIGTERM');
    const interrupted = await result;
    expect(interrupted.code).toBe(4);
    expect(interrupted.stdout).toContain('NO VERDICT  interrupted');
  });

  test('a cancelled run and a run waiting for an approval are exit 4, never a pass', () => {
    const ci = bed();
    ci.fixture('run-41.json', run(41, 'completed', 'cancelled'));
    const cancelled = watch(ci, '--run', '41');
    expect(cancelled.code).toBe(4);
    expect(cancelled.stdout).toContain("ended as 'cancelled'");

    ci.fixture('run-42.json', run(42, 'waiting', null));
    const waiting = watch(ci, '--run', '42');
    expect(waiting.code).toBe(4);
    expect(waiting.stdout).toContain("That approval\n    is the user's");
    expectReadOnly(ci.calls());
  });

  test('usage errors are exit 2 before any gh call', () => {
    const ci = bed();
    for (const args of [
      [],
      ['--run', '11', '--sha', SHA],
      ['--run', 'latest'],
      ['--sha', '7bc922db'],
      ['--run', '11', '--workflow', 'CI'],
      ['--run', '11', '--timeout', '0'],
      ['--run', '11', '--interval', 'soon'],
      ['--run', '11', '--repo', 'not a repo'],
    ]) {
      expect({ args, code: watch(ci, ...args).code }).toEqual({ args, code: 2 });
    }
    expect(ci.calls()).toEqual([]);
  });
});
