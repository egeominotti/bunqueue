import { expect, test } from 'bun:test';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = `${import.meta.dir}/..`;
const workflow = Bun.YAML.parse(await Bun.file(`${root}/.github/workflows/ci.yml`).text()) as {
  jobs: Record<string, { steps: Array<{ id?: string; run?: string }> }>;
};
const script = workflow.jobs['version-gate'].steps.find((step) => step.id === 'gate')!.run!;
const version = ((await Bun.file(`${root}/package.json`).json()) as { version: string }).version;

// `ls-remote` exits with GIT_EXIT and, on success, lists the existing release
// tag; the tag's commit carries the same package version.
const MOCK_GIT = `#!/bin/sh
case "$1" in
  ls-remote)
    if [ "$GIT_EXIT" = 0 ]; then printf '%s\\trefs/tags/v%s\\n' "$TAG_COMMIT" "$VERSION"; fi
    exit "$GIT_EXIT" ;;
  fetch) exit 0 ;;
  show) printf '{"version":"%s"}' "$VERSION" ;;
  *) exit 97 ;;
esac
`;

async function gate(gitExit: number, npmVersion = '') {
  const directory = await mkdtemp(join(tmpdir(), 'bunqueue-version-gate-'));
  try {
    const mockGit = join(directory, 'git');
    await Bun.write(mockGit, MOCK_GIT);
    await chmod(mockGit, 0o755);
    const output = join(directory, 'output');
    await Bun.write(output, '');
    const child = Bun.spawn(['bash', '-c', script], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GIT_EXIT: String(gitExit),
        GITHUB_OUTPUT: output,
        GITHUB_SHA: 'b'.repeat(40),
        TAG_COMMIT: 'a'.repeat(40),
        VERSION: version,
        REBUILD_DOCKER: 'true',
        REQUESTED_NPM_VERSION: npmVersion,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr, output: await Bun.file(output).text() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('an existing release permits Docker rebuild without a new GitHub release', async () => {
  const result = await gate(0);
  expect(result.code).toBe(0);
  expect(result.output).toContain('should_release=false\n');
  expect(result.output).toContain('should_build=true\n');
  expect(result.output).toContain(`source_sha=${'a'.repeat(40)}\n`);
});

test('an absent tag permits the normal release path', async () => {
  const result = await gate(2);
  expect(result.code).toBe(0);
  expect(result.output).toContain('should_release=true\n');
  expect(result.output).toContain(`source_sha=${'b'.repeat(40)}\n`);
});

test('Git network or authentication failure blocks release and Docker publication', async () => {
  const result = await gate(128);
  expect(result.code).not.toBe(0);
  expect(result.output).not.toContain('should_release=true\n');
  expect(result.output).not.toContain('should_build=true\n');
  expect(result.output).not.toContain('source_sha=');
});

test('an npm version mismatch blocks all publication before the Git lookup', async () => {
  const result = await gate(2, '0.0.0-invalid');
  expect(result.code).not.toBe(0);
  expect(result.output).toBe('');
});
