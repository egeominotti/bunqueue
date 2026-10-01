/**
 * Regression: the TypeScript SDK release could not authenticate.
 *
 * `.github/workflows/sdk-release.yml` ran `bun publish --provenance` with
 * `NODE_AUTH_TOKEN`. The pinned Bun CLI ignores both `NODE_AUTH_TOKEN` and the
 * `setup-node` `.npmrc` (`NPM_CONFIG_USERCONFIG`), and silently accepts
 * `--provenance` without producing provenance. The root npm job was already
 * fixed to pass `NPM_CONFIG_TOKEN`, verify `bun pm whoami`, dry-run the packed
 * tarball, and publish exactly that tarball; the SDK release must do the same.
 */
import { describe, expect, test } from 'bun:test';

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  'working-directory'?: string;
};
type Job = { needs?: string[]; permissions?: Record<string, string>; steps?: Step[] };

const root = `${import.meta.dir}/..`;
const text = await Bun.file(`${root}/.github/workflows/sdk-release.yml`).text();
const workflow = Bun.YAML.parse(text) as { jobs: Record<string, Job> };
const publishJob = workflow.jobs.publish;
const steps = publishJob.steps ?? [];
const sdkName = ((await Bun.file(`${root}/sdk/typescript/package.json`).json()) as { name: string })
  .name;
const TARBALL = `"/tmp/typescript-package/${sdkName}-$SDK_VERSION.tgz"`;
const TOKEN = '${{ secrets.NPM_TOKEN }}';

const index = (predicate: (step: Step) => boolean) => steps.findIndex(predicate);
const pack = index(
  (step) => step.run?.includes('bun pm pack --destination /tmp/typescript-package') ?? false
);
const validate = index((step) => step.name === 'Validate requested version and tag');
const dryRun = index((step) => step.name === 'Verify npm authentication and publication dry run');
const publish = index((step) => step.name === 'Publish the verified tarball');
const tag = index((step) => step.name === 'Tag the published commit');

describe('SDK release authentication', () => {
  test('Bun receives the token through NPM_CONFIG_TOKEN, never NODE_AUTH_TOKEN', () => {
    expect(text).not.toContain('NODE_AUTH_TOKEN');
    expect(steps[dryRun]?.env?.NPM_CONFIG_TOKEN).toBe(TOKEN);
    expect(steps[publish]?.env?.NPM_CONFIG_TOKEN).toBe(TOKEN);
  });

  test('credentials reach only the authentication, dry-run, and publication steps', () => {
    const credentialed = steps
      .map((step, position) => ({ step, position }))
      .filter(({ step }) => JSON.stringify(step).includes('secrets.'))
      .map(({ position }) => position);
    expect(credentialed).toEqual([dryRun, publish]);
  });

  test('provenance is neither requested nor claimed nor granted an OIDC token', () => {
    expect(text).not.toContain('--provenance');
    expect(text.toLowerCase()).not.toContain('provenance');
    expect(publishJob.permissions?.['id-token']).toBeUndefined();
    expect(publishJob.permissions?.contents).toBe('write');
  });

  test('whoami and a tarball dry run precede publication of the same packed tarball', () => {
    expect(pack).toBeGreaterThan(-1);
    expect(validate).toBeGreaterThan(pack);
    expect(dryRun).toBeGreaterThan(validate);
    expect(publish).toBeGreaterThan(dryRun);
    expect(tag).toBeGreaterThan(publish);
    const verification = steps[dryRun].run ?? '';
    expect(verification).toContain('bun pm whoami');
    expect(verification).toContain(`bun publish --dry-run ${TARBALL}`);
    expect(verification.indexOf('bun pm whoami')).toBeLessThan(
      verification.indexOf('bun publish --dry-run')
    );
    expect(steps[publish].run?.trim()).toBe(`bun publish --access public ${TARBALL}`);
    expect(text).not.toContain('npm publish');
  });

  test('the existing branch, version, tag, and registry gates stay fail-closed', () => {
    expect(text).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(text).toContain('test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"');
    const gate = steps[validate].run ?? '';
    expect(gate).toContain('test "$REQUESTED_VERSION" = "$VERSION"');
    expect(gate).toContain('TAG="sdk-ts-v$VERSION"');
    // Only Git's exit status 2 means "tag absent"; network/auth errors stop.
    expect(gate).toContain('"$status" -ne 2');
    // Only an explicit 404 means "version absent"; any other answer stops.
    expect(gate).toContain('response.status !== 404');
    expect(gate).toContain('https://registry.npmjs.org/');
  });
});
