import { chmod, copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs the real sandbox entry point with an isolated, deterministic Docker stand-in. */
export async function sandboxRunnerFixture(
  mode: 'success' | 'failed-count' | 'cleanup-failure' | 'test-error' | 'incomplete'
) {
  const directory = await mkdtemp(join(tmpdir(), 'bunqueue-sandbox-runner-'));
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'bin'));
  const root = join(import.meta.dir, '../..');
  for (const name of [
    'test-sandbox.ts',
    'test-sandbox-cleanup.ts',
    'test-sandbox-report.ts',
    'test-sandbox-telemetry.ts',
    'test-sandbox-log-parser.ts',
    'test-sandbox-results.ts',
    'test-sandbox-checkpoints.ts',
  ]) {
    await copyFile(join(root, 'scripts', name), join(directory, 'scripts', name));
  }
  const docker = join(directory, 'bin', 'docker');
  await Bun.write(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$AUDIT_CALLS"
case "$1" in
info) echo fake-docker ;;
build) exit 0 ;;
run)
  sleep 0.1
  case "$AUDIT_MODE" in
    failed-count) printf ' 1 pass\\n 1 fail\\nRan 2 tests across 1 files.\\n' ;;
    test-error) printf ' 1 pass\\n 0 fail\\n 1 error\\nRan 1 tests across 1 files.\\n' ;;
    incomplete) printf ' 1 pass\\n 0 fail\\n' ;;
    *) case "$*" in
      *scripts/tcp/run-all-tests.ts*) printf 'TEST_FILE_RESULT {"file":"a.ts","passed":1,"failed":0,"durationMs":1}\\nTCP FINAL SUMMARY\\nSuites: 1/1 passed\\nAssertions: 1/1 passed\\n' ;;
      *scripts/embedded/run-all-tests.ts*) printf 'TEST_FILE_RESULT {"file":"a.ts","passed":1,"failed":0,"durationMs":1}\\nTest Suites: 1/1 passed\\nIndividual Tests: 1/1 passed\\n' ;;
      *) printf ' 1 pass\\n 0 fail\\nRan 1 tests across 1 files.\\n' ;;
    esac ;;
  esac ;;
stats)
  sleep 0.05
  printf '{"BlockIO":"0B / 0B","CPUPerc":"1%%","MemPerc":"1%%","MemUsage":"1MiB / 4GiB","NetIO":"0B / 0B","PIDs":"1"}\\n' ;;
inspect) echo false ;;
rm) if [ "$AUDIT_MODE" = cleanup-failure ]; then echo 'removal failed' >&2; exit 17; fi ;;
*) echo "unexpected fake call: $*" >&2; exit 99 ;;
esac
`
  );
  await chmod(docker, 0o755);
  const callsPath = join(directory, 'calls.log');
  const process = Bun.spawn(
    [globalThis.process.execPath, join(directory, 'scripts/test-sandbox.ts')],
    {
      cwd: directory,
      env: {
        ...globalThis.process.env,
        PATH: `${join(directory, 'bin')}:${globalThis.process.env.PATH}`,
        AUDIT_MODE: mode,
        AUDIT_CALLS: callsPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  const logDirectory = stdout.match(/Complete suite logs: (.+)/)?.[1];
  const report = logDirectory ? await Bun.file(join(logDirectory, 'summary.json')).json() : null;
  return {
    directory,
    exitCode,
    stdout,
    stderr,
    report,
    calls: (await readFile(callsPath, 'utf8')).trim().split('\n'),
  };
}
