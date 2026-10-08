/**
 * Regression: released artifacts must be built from the release tag's commit.
 *
 * Git tag `v2.9.5` points to 105b8794, yet npm `bunqueue@2.9.5` shipped
 * `dist/cli/commands/healthcheck.js`, which does not exist at that tag, and the
 * Docker Hub `2.9.5` tags were rebuilt several times from later main commits.
 * A manual `rebuild_docker`/`npm_version` run rebuilt whatever main contained
 * because every publishing job checked out `github.sha`, and the GitHub release
 * action created the tag at main's HEAD at the end of a ~20-minute pipeline.
 */
import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = { needs?: string | string[]; outputs?: Record<string, string>; steps?: Step[] };

const root = `${import.meta.dir}/..`;
const ci = Bun.YAML.parse(await Bun.file(`${root}/.github/workflows/ci.yml`).text()) as {
  jobs: Record<string, Job>;
};
const version = ((await Bun.file(`${root}/package.json`).json()) as { version: string }).version;
const SOURCE = '${{ needs.version-gate.outputs.source_sha }}';
const VERSION = '${{ needs.version-gate.outputs.version }}';
// `npm` checks out nothing: it publishes the tarball `npm-pack` built from SOURCE.
const PUBLISHING_JOBS = ['build', 'docker-test', 'docker', 'npm-pack', 'release'] as const;
const TAG_COMMIT = '1'.repeat(40);
const TAG_OBJECT = '2'.repeat(40);
const MAIN_COMMIT = '3'.repeat(40);

const action = (step: Step) => step.uses?.split('@')[0];
const needs = (job: Job | undefined) =>
  job?.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];

function ancestors(name: string, seen = new Set<string>()): Set<string> {
  for (const dependency of needs(ci.jobs[name])) {
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    ancestors(dependency, seen);
  }
  return seen;
}

async function run(script: string, env: Record<string, string>, stubs: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), 'bunqueue-release-source-'));
  try {
    for (const [name, body] of Object.entries(stubs)) {
      await Bun.write(join(directory, name), body);
      await chmod(join(directory, name), 0o755);
    }
    const output = join(directory, 'output');
    const log = join(directory, 'calls');
    await Bun.write(output, '');
    await Bun.write(log, '');
    const child = Bun.spawn(['bash', '-c', script], {
      cwd: root,
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        CALL_LOG: log,
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill(), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return {
        code,
        stdout,
        stderr,
        output: await Bun.file(output).text(),
        calls: await Bun.file(log).text(),
      };
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// `git ls-remote` prints the configured refs; `git show <sha>:package.json`
// answers only for the expected commit, so reading the working tree's
// package.json (main) instead of the tag commit's cannot pass.
const GIT_STUB = `#!/bin/sh
printf 'git %s\\n' "$*" >> "$CALL_LOG"
case "$1" in
  ls-remote)
    if [ -n "$LS_REMOTE_OUTPUT" ]; then printf '%s\\n' "$LS_REMOTE_OUTPUT"; fi
    exit "$LS_REMOTE_EXIT" ;;
  fetch) exit 0 ;;
  show)
    if [ "$2" = "$TAG_COMMIT_FILE" ]; then printf '%s' "$TAG_PACKAGE_JSON"; exit 0; fi
    exit 128 ;;
  *) exit 97 ;;
esac
`;

const gateScript = ci.jobs['version-gate']?.steps?.find((step) => step.id === 'gate')?.run ?? '';

function gate(options: {
  refs: string[];
  exit: number;
  tagVersion?: string;
  requestedNpm?: string;
}) {
  return run(
    gateScript,
    {
      GITHUB_SHA: MAIN_COMMIT,
      REBUILD_DOCKER: 'true',
      REQUESTED_NPM_VERSION: options.requestedNpm ?? '',
      LS_REMOTE_OUTPUT: options.refs.join('\n'),
      LS_REMOTE_EXIT: String(options.exit),
      TAG_COMMIT_FILE: `${TAG_COMMIT}:package.json`,
      TAG_PACKAGE_JSON: JSON.stringify({ version: options.tagVersion ?? version }),
    },
    { git: GIT_STUB }
  );
}

describe('version gate resolves the exact release source commit', () => {
  test('the gate exposes the resolved source commit as a job output', () => {
    expect(ci.jobs['version-gate']?.outputs?.source_sha).toBe(
      '${{ steps.gate.outputs.source_sha }}'
    );
  });

  test('an existing lightweight tag is rebuilt from its tagged commit, not main', async () => {
    const result = await gate({ refs: [`${TAG_COMMIT}\trefs/tags/v${version}`], exit: 0 });
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.output).toContain(`source_sha=${TAG_COMMIT}\n`);
    expect(result.output).not.toContain(MAIN_COMMIT);
    expect(result.output).toContain('should_release=false\n');
    expect(result.output).toContain('should_build=true\n');
    expect(result.calls).toContain(`git show ${TAG_COMMIT}:package.json`);
  });

  test('an annotated tag is dereferenced to its commit instead of the tag object', async () => {
    const result = await gate({
      refs: [`${TAG_OBJECT}\trefs/tags/v${version}`, `${TAG_COMMIT}\trefs/tags/v${version}^{}`],
      exit: 0,
    });
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.output).toContain(`source_sha=${TAG_COMMIT}\n`);
    expect(result.output).not.toContain(TAG_OBJECT);
  });

  test('a tag whose commit carries another package version fails loudly', async () => {
    const result = await gate({
      refs: [`${TAG_COMMIT}\trefs/tags/v${version}`],
      exit: 0,
      tagVersion: '0.0.0-tag-mismatch',
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('::error::');
    expect(result.output).not.toContain('should_build=true');
    expect(result.output).not.toContain('source_sha=');
  });

  test('a successful listing without a resolvable commit fails closed', async () => {
    const result = await gate({ refs: [], exit: 0 });
    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain('should_build=true');
    expect(result.output).not.toContain('source_sha=');
  });

  test('a new version is released from the pushed commit', async () => {
    const result = await gate({ refs: [], exit: 2 });
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.output).toContain(`source_sha=${MAIN_COMMIT}\n`);
    expect(result.output).toContain('should_release=true\n');
  });
});

describe('every release-producing job uses the resolved source commit', () => {
  test('publishing jobs depend on the gate and check out exactly its commit', () => {
    for (const name of PUBLISHING_JOBS) {
      const job = ci.jobs[name];
      expect(needs(job), name).toContain('version-gate');
      const checkouts = (job?.steps ?? []).filter((step) => action(step) === 'actions/checkout');
      expect(checkouts.length, name).toBeGreaterThan(0);
      for (const checkout of checkouts) expect(checkout.with?.ref, name).toBe(SOURCE);
    }
  });

  test('no job downstream of the gate checks out the triggering commit', () => {
    for (const [name, job] of Object.entries(ci.jobs)) {
      if (!ancestors(name).has('version-gate')) continue;
      for (const step of job.steps ?? []) {
        if (action(step) === 'actions/checkout') expect(step.with?.ref, name).toBe(SOURCE);
      }
    }
  });

  test('the binary build proves the checked-out commit and package version', () => {
    const verify = ci.jobs.build?.steps?.find((step) => step.env?.SOURCE_SHA === SOURCE);
    expect(verify?.run).toContain('git rev-parse HEAD');
    expect(verify?.run).toContain('"$SOURCE_SHA"');
    expect(verify?.env?.EXPECTED_VERSION).toBe(VERSION);
  });

  test('the GitHub release tags the source commit instead of the moving default branch', () => {
    const release = ci.jobs.release?.steps?.find(
      (step) => action(step) === 'softprops/action-gh-release'
    );
    expect(release?.with?.target_commitish).toBe(SOURCE);
  });

  test('images are labelled with the source revision and release version', () => {
    const build = ci.jobs['docker-test']?.steps?.find(
      (step) => action(step) === 'docker/build-push-action'
    );
    const labels = String(build?.with?.labels ?? '')
      .trim()
      .split('\n');
    expect(labels).toContain(`org.opencontainers.image.revision=${SOURCE}`);
    expect(labels).toContain(`org.opencontainers.image.version=${VERSION}`);
  });
});

describe('image provenance is enforced before publication', () => {
  const steps = ci.jobs['docker-test']?.steps ?? [];
  const verifyIndex = steps.findIndex((step) => step.name === 'Verify release provenance labels');
  const verify = steps[verifyIndex];
  const DOCKER_INSPECT_STUB = `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  *org.opencontainers.image.revision*) printf '%s\\n' "$LABEL_REVISION" ;;
  *org.opencontainers.image.version*) printf '%s\\n' "$LABEL_VERSION" ;;
  *) exit 97 ;;
esac
`;

  function verifyLabels(revision: string, labelVersion: string) {
    return run(
      verify?.run ?? 'exit 99',
      {
        IMAGE: 'bunqueue-candidate:debian-amd64',
        SOURCE_SHA: TAG_COMMIT,
        VERSION: version,
        LABEL_REVISION: revision,
        LABEL_VERSION: labelVersion,
      },
      { docker: DOCKER_INSPECT_STUB }
    );
  }

  test('the label check runs after the build and before the tested image is exported', () => {
    const build = steps.findIndex((step) => action(step) === 'docker/build-push-action');
    const exportStep = steps.findIndex((step) => step.name === 'Export tested image');
    expect(verifyIndex).toBeGreaterThan(build);
    expect(verifyIndex).toBeLessThan(exportStep);
    expect(verify?.env?.SOURCE_SHA).toBe(SOURCE);
    expect(verify?.env?.VERSION).toBe(VERSION);
  });

  test('matching labels pass', async () => {
    const result = await verifyLabels(TAG_COMMIT, version);
    expect(result.code, result.stderr).toBe(0);
    expect(result.calls).toContain('bunqueue-candidate:debian-amd64');
  });

  test.each([
    ['revision', MAIN_COMMIT, version],
    ['version', TAG_COMMIT, '0.0.0-other'],
    ['missing revision', '', version],
  ])('a %s mismatch blocks publication', async (_label, revision, labelVersion) => {
    const result = await verifyLabels(revision, labelVersion);
    expect(result.code).not.toBe(0);
  });

  test('a release source without the variant build inputs fails before any image build', async () => {
    const preflight = steps.findIndex((step) =>
      step.name?.startsWith('Require variant-aware image build inputs')
    );
    const build = steps.findIndex((step) => action(step) === 'docker/build-push-action');
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(build);
    const script = steps[preflight].run!;
    const current = await run(script, { SOURCE_SHA: TAG_COMMIT }, {});
    expect(current.code, current.stdout + current.stderr).toBe(0);
    const legacy = await mkdtemp(join(tmpdir(), 'bunqueue-legacy-source-'));
    try {
      // The v2.9.5 Dockerfile had a single Alpine stage and no image test script.
      await Bun.write(join(legacy, 'Dockerfile'), 'FROM oven/bun:1.4.2-alpine AS production\n');
      const child = Bun.spawn(['bash', '-c', script], {
        cwd: legacy,
        env: { PATH: process.env.PATH, SOURCE_SHA: TAG_COMMIT },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).not.toBe(0);
      expect(stdout).toContain('::error::');
    } finally {
      await rm(legacy, { recursive: true, force: true });
    }
  });

  test('GHCR staging tags name the source commit, not the dispatching commit', async () => {
    const publish = ci.jobs.docker?.steps?.find(
      (step) => step.name === 'Publish the tested images and multi-platform tags'
    );
    expect(publish?.env?.SOURCE_SHA).toBe(SOURCE);
    const result = await run(
      publish?.run ?? 'exit 99',
      {
        REGISTRY: 'ghcr.io',
        IMAGE_NAME: 'egeominotti/bunqueue',
        GITHUB_SHA: MAIN_COMMIT,
        SOURCE_SHA: TAG_COMMIT,
        VARIANT: 'debian',
        TAGS: [
          `ghcr.io/egeominotti/bunqueue:${version}-debian`,
          `docker.io/egeominotti/bunqueue:${version}-debian`,
        ].join('\n'),
      },
      { docker: '#!/bin/sh\nprintf "docker %s\\n" "$*" >> "$CALL_LOG"\n' }
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.calls).toContain(`push ghcr.io/egeominotti/bunqueue:${TAG_COMMIT}-debian-amd64`);
    expect(result.calls).not.toContain(MAIN_COMMIT);
  });
});
