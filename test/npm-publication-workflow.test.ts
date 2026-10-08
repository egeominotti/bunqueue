import { expect, test } from 'bun:test';

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = {
  if?: string;
  environment?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: Step[];
};
const text = await Bun.file(`${import.meta.dir}/../.github/workflows/ci.yml`).text();
const workflow = Bun.YAML.parse(text) as {
  on: { workflow_dispatch: { inputs: Record<string, { default: unknown }> } };
  jobs: Record<string, Job>;
};
const pack = workflow.jobs['npm-pack'];
const npm = workflow.jobs.npm;
const TARBALL = '"/tmp/npm-package/bunqueue-$REQUESTED_VERSION.tgz"';
const action = (step: Step) => step.uses?.split('@')[0];

test('root npm publication requires an explicit version, main, and successful product gates', () => {
  expect(workflow.on.workflow_dispatch.inputs.npm_version.default).toBe('');
  for (const job of [pack, npm]) {
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.if).toContain("inputs.npm_version != ''");
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
  }
  expect(pack.if).toContain("needs.docker.result == 'success'");
  expect(npm.if).toContain("needs.npm-pack.result == 'success'");
  const seen = new Set<string>();
  function visit(name: string) {
    for (const dependency of workflow.jobs[name].needs ?? []) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      visit(dependency);
    }
  }
  visit('npm');
  for (const gate of ['quality-gate', 'sdk', 'build', 'docker-test', 'docker', 'npm-pack']) {
    expect(seen.has(gate)).toBe(true);
  }
});

test('the pack job verifies, smoke-tests and packs without any credential', () => {
  expect(pack.permissions).toEqual({ contents: 'read' });
  expect(pack.environment).toBeUndefined();
  expect(JSON.stringify(pack)).not.toContain('secrets.');
  const steps = pack.steps ?? [];
  const verify = steps.findIndex((step) => step.name?.startsWith('Verify the explicitly'));
  const build = steps.findIndex(
    (step) => step.name === 'Build and verify the package consumer contract'
  );
  const upload = steps.findIndex((step) => action(step) === 'actions/upload-artifact');
  expect(verify).toBeGreaterThan(-1);
  expect(build).toBeGreaterThan(verify);
  expect(upload).toBeGreaterThan(build);
  expect(steps[verify].run).toContain('response.status !== 404');
  // Provenance records GITHUB_SHA, so the packed commit must be that commit.
  expect(steps[verify].run).toContain('"$SOURCE_SHA" != "$GITHUB_SHA"');
  expect(steps[build].run).toContain('bun test test/package-consumer-smoke.test.ts');
  expect(steps[build].run).toContain('bun pm pack --ignore-scripts --destination /tmp/npm-package');
  expect(steps[upload].with?.['if-no-files-found']).toBe('error');
});

test('the publish job holds only the OIDC permission and runs no repository code', () => {
  // The trusted publisher on npmjs.com is bound to ci.yml and environment `npm`.
  expect(npm.environment).toBe('npm');
  expect(npm.permissions).toEqual({ 'id-token': 'write' });
  const job = JSON.stringify(npm);
  for (const forbidden of ['secrets.', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'bun ', 'setup-bun']) {
    expect(job).not.toContain(forbidden);
  }
  const steps = npm.steps ?? [];
  expect(steps.some((step) => action(step) === 'actions/checkout')).toBe(false);
});

test('the publish job dry-runs and publishes the downloaded tarball with a pinned npm', () => {
  const steps = npm.steps ?? [];
  const download = steps.findIndex((step) => action(step) === 'actions/download-artifact');
  const cli = steps.findIndex(
    (step) => step.name === 'Install the npm CLI used for trusted publishing'
  );
  const dryRun = steps.findIndex((step) => step.name === 'Publication dry run');
  const publish = steps.findIndex((step) => step.name?.startsWith('Publish the verified tarball'));
  expect(download).toBe(0);
  expect(cli).toBeGreaterThan(download);
  expect(dryRun).toBeGreaterThan(cli);
  expect(publish).toBeGreaterThan(dryRun);
  expect(steps[download].with?.name).toBe(
    (pack.steps ?? []).find((step) => action(step) === 'actions/upload-artifact')?.with?.name
  );

  // Trusted publishing needs npm >= 11.5.1: pinned exactly and checked at runtime.
  const pinned = /npm install -g npm@(\d+)\.(\d+)\.(\d+)\b/.exec(steps[cli].run ?? '');
  expect(pinned).not.toBeNull();
  const [major, minor, patch] = (pinned ?? []).slice(1).map(Number);
  expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(11_005_001);
  expect(steps[cli].run).toContain('11005001');

  expect(steps[dryRun].run).toBe(
    `npm publish --dry-run --ignore-scripts --access public ${TARBALL}`
  );
  expect(steps[publish].run).toBe(
    `npm publish --ignore-scripts --access public --provenance ${TARBALL}`
  );
});
