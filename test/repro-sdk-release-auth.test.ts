/**
 * Regression: the TypeScript SDK release could not authenticate.
 *
 * `.github/workflows/sdk-release.yml` ran `bun publish --provenance` with
 * `NODE_AUTH_TOKEN`. The pinned Bun CLI ignores both `NODE_AUTH_TOKEN` and the
 * `setup-node` `.npmrc` (`NPM_CONFIG_USERCONFIG`), and silently accepts
 * `--provenance` without producing provenance.
 *
 * The release now uses npm trusted publishing in two jobs: `pack` installs,
 * builds and packs with Bun and holds no credential; `publish` holds the OIDC
 * permission, runs no repository code, and publishes exactly that tarball with
 * the npm CLI (which supports OIDC) and a provenance attestation.
 */
import { describe, expect, test } from 'bun:test';

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  'working-directory'?: string;
};
type Job = {
  needs?: string[];
  environment?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  steps?: Step[];
};

const root = `${import.meta.dir}/..`;
const text = await Bun.file(`${root}/.github/workflows/sdk-release.yml`).text();
const workflow = Bun.YAML.parse(text) as { jobs: Record<string, Job> };
const packJob = workflow.jobs.pack;
const publishJob = workflow.jobs.publish;
const packSteps = packJob.steps ?? [];
const steps = publishJob.steps ?? [];
const sdkName = ((await Bun.file(`${root}/sdk/typescript/package.json`).json()) as { name: string })
  .name;
const TARBALL = `"/tmp/typescript-package/${sdkName}-$SDK_VERSION.tgz"`;
const action = (step: Step) => step.uses?.split('@')[0];

const packIndex = (predicate: (step: Step) => boolean) => packSteps.findIndex(predicate);
const pack = packIndex(
  (step) => step.run?.includes('bun pm pack --destination /tmp/typescript-package') ?? false
);
const validate = packIndex((step) => step.name === 'Validate requested version and tag');
const upload = packIndex((step) => action(step) === 'actions/upload-artifact');

const index = (predicate: (step: Step) => boolean) => steps.findIndex(predicate);
const download = index((step) => action(step) === 'actions/download-artifact');
const cli = index((step) => step.name === 'Install the npm CLI used for trusted publishing');
const dryRun = index((step) => step.name === 'Publication dry run');
const publish = index((step) => step.name?.startsWith('Publish the verified tarball') ?? false);
const tag = index((step) => step.name === 'Tag the published commit');

describe('SDK release authentication', () => {
  test('the pack job builds without any credential', () => {
    expect(packJob.needs).toEqual(['sdk']);
    expect(packJob.permissions).toEqual({ contents: 'read' });
    expect(packJob.environment).toBeUndefined();
    expect(JSON.stringify(packJob)).not.toContain('secrets.');
  });

  test('npm authenticates through OIDC in a publish job that runs no repository code', () => {
    // The trusted publisher on npmjs.com is bound to sdk-release.yml and `npm`.
    expect(publishJob.needs).toEqual(['pack']);
    expect(publishJob.environment).toBe('npm');
    expect(publishJob.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
    const job = JSON.stringify(publishJob);
    for (const forbidden of ['bun ', 'setup-bun', 'secrets.']) {
      expect(job).not.toContain(forbidden);
    }
    // The tag lands on the exact commit the pack job built.
    const checkout = steps.find((step) => action(step) === 'actions/checkout');
    expect(checkout?.with?.ref).toBe('${{ needs.pack.outputs.commit }}');
    expect(publishJob.env?.SDK_VERSION ?? '').toBe('${{ needs.pack.outputs.version }}');
  });

  test('no long-lived npm credential exists anywhere in the workflow', () => {
    expect(text).not.toContain('NPM_TOKEN');
    expect(text).not.toContain('NODE_AUTH_TOKEN');
    expect(text).not.toContain('NPM_CONFIG_TOKEN');
  });

  test('the npm CLI is pinned to a version that supports trusted publishing', () => {
    expect(cli).toBeGreaterThan(-1);
    expect(cli).toBeLessThan(dryRun);
    const pinned = /npm install -g npm@(\d+)\.(\d+)\.(\d+)\b/.exec(steps[cli].run ?? '');
    expect(pinned).not.toBeNull();
    const [major, minor, patch] = (pinned ?? []).slice(1).map(Number);
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(11_005_001);
    expect(steps[cli].run).toContain('11005001');
  });

  test('a tarball dry run precedes publication of the same packed tarball', () => {
    expect(pack).toBeGreaterThan(-1);
    expect(validate).toBeGreaterThan(pack);
    expect(upload).toBeGreaterThan(validate);
    expect(packSteps[upload].with?.['if-no-files-found']).toBe('error');
    expect(steps[download]?.with?.name).toBe(packSteps[upload].with?.name);
    expect(dryRun).toBeGreaterThan(download);
    expect(publish).toBeGreaterThan(dryRun);
    expect(tag).toBeGreaterThan(publish);
    expect(steps[dryRun].run?.trim()).toBe(
      `npm publish --dry-run --ignore-scripts --access public ${TARBALL}`
    );
    expect(steps[publish].run?.trim()).toBe(
      `npm publish --ignore-scripts --access public --provenance ${TARBALL}`
    );
    expect(text).not.toContain('bun publish');
  });

  test('the existing branch, version, tag, and registry gates stay fail-closed', () => {
    expect(text).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(text).toContain('test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"');
    const gate = packSteps[validate].run ?? '';
    expect(gate).toContain('test "$REQUESTED_VERSION" = "$VERSION"');
    expect(gate).toContain('TAG="sdk-ts-v$VERSION"');
    // Only Git's exit status 2 means "tag absent"; network/auth errors stop.
    expect(gate).toContain('"$status" -ne 2');
    // Only an explicit 404 means "version absent"; any other answer stops.
    expect(gate).toContain('response.status !== 404');
    expect(gate).toContain('https://registry.npmjs.org/');
  });
});
