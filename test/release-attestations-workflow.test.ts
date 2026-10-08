/**
 * Release artifacts carry keyless Sigstore attestations (GitHub artifact
 * attestations): signed SLSA build provenance for every published image and
 * release archive, and a CycloneDX SBOM for every image. Consumers verify them
 * with `gh attestation verify`.
 *
 * Images are signed after publication by two jobs the release does not depend
 * on, so a signing failure never blocks the release or npm: `docker-sbom`
 * resolves digests and builds the SBOM with no signing credential, and
 * `docker-attest` only signs.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: Step[];
};

const text = await Bun.file(`${import.meta.dir}/../.github/workflows/ci.yml`).text();
const ci = Bun.YAML.parse(text) as { jobs: Record<string, Job> };
const action = (step: Step) => step.uses?.split('@')[0];
const GHCR = '${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}';
const GHCR_DIGEST = '${{ steps.digests.outputs.ghcr }}';
const named = (job: Job, name: string) => (job.steps ?? []).findIndex((s) => s.name === name);

describe('image signing never blocks publication', () => {
  test('the docker job publishes without any signing permission', () => {
    expect(ci.jobs.docker.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(JSON.stringify(ci.jobs.docker)).not.toContain('actions/attest');
  });

  test('release and npm do not depend on the signing jobs', () => {
    for (const job of ['release', 'npm-pack', 'npm']) {
      expect(ci.jobs[job].needs).not.toContain('docker-sbom');
      expect(ci.jobs[job].needs).not.toContain('docker-attest');
    }
    expect(ci.jobs['docker-sbom'].needs).toEqual(['version-gate', 'docker']);
    expect(ci.jobs['docker-attest'].needs).toEqual(['version-gate', 'docker-sbom']);
  });

  test('rebuilds of an already released version are not attested', () => {
    // Provenance records github.sha, so only the triggering commit is attested.
    expect(ci.jobs['docker-sbom'].if).toContain("needs.docker.result == 'success'");
    expect(ci.jobs['docker-sbom'].if).toContain(
      'needs.version-gate.outputs.source_sha == github.sha'
    );
    expect(ci.jobs['docker-attest'].if).toBe("needs.docker-sbom.result == 'success'");
  });
});

describe('docker-sbom', () => {
  const job = ci.jobs['docker-sbom'];
  const steps = job.steps ?? [];
  const digests = named(job, 'Resolve the published image digests');
  const sbom = named(job, 'Generate the image SBOM');

  test('holds no signing credential and checks out no code', () => {
    expect(job.permissions).toEqual({ contents: 'read', packages: 'read' });
    expect(steps.some((step) => action(step) === 'actions/checkout')).toBe(false);
  });

  test('resolves validated index digests and builds the SBOM of that digest', () => {
    expect(digests).toBe(0);
    const script = steps[digests].run ?? '';
    expect(script).toContain('docker buildx imagetools inspect');
    expect(script).toContain('$REGISTRY/$IMAGE_NAME:$SOURCE_SHA-$VARIANT');
    expect(script).toContain('docker.io/egeominotti/bunqueue:$VERSION-$VARIANT');
    expect(script).toContain('^sha256:[0-9a-f]{64}$');
    expect(action(steps[sbom])).toBe('anchore/sbom-action');
    expect(steps[sbom].with?.image).toBe(`${GHCR}@${GHCR_DIGEST}`);
    expect(steps[sbom].with?.format).toBe('cyclonedx-json');
    expect(steps[sbom].with?.['upload-release-assets']).toBe(false);
    expect(steps[sbom].with?.['output-file']).toBe('/tmp/attest/sbom.cdx.json');
  });

  test('the digest script refuses anything that is not a sha256 digest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bunqueue-attest-digest-'));
    try {
      const docker = join(directory, 'docker');
      await Bun.write(docker, '#!/bin/sh\nprintf \'%s\' "$FAKE_MANIFEST"\n');
      await chmod(docker, 0o755);
      const runScript = async (manifest: string) => {
        const child = Bun.spawn(['bash', '-c', steps[digests].run ?? 'exit 99'], {
          env: {
            PATH: `${directory}:${process.env.PATH}`,
            FAKE_MANIFEST: manifest,
            GITHUB_OUTPUT: join(directory, 'output'),
            REGISTRY: 'ghcr.io',
            IMAGE_NAME: 'egeominotti/bunqueue',
            VARIANT: 'alpine',
            VERSION: '9.9.9',
            SOURCE_SHA: 'a'.repeat(40),
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        return child.exited;
      };
      expect(await runScript('{"digest":"not-a-digest"}')).not.toBe(0);
      expect(await runScript(`{"digest":"sha256:${'b'.repeat(64)}"}`)).toBe(0);
      const saved = await Bun.file('/tmp/attest/digests.env').text();
      expect(saved).toBe(`ghcr=sha256:${'b'.repeat(64)}\nhub=sha256:${'b'.repeat(64)}\n`);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm('/tmp/attest', { recursive: true, force: true });
    }
  });
});

describe('docker-attest', () => {
  const job = ci.jobs['docker-attest'];
  const steps = job.steps ?? [];
  const ghcr = named(job, 'Attest image provenance (GHCR)');
  const hub = named(job, 'Attest image provenance (Docker Hub)');
  const sbom = named(job, 'Attest the image SBOM');

  test('only signs: no checkout, no Bun, no third-party build code', () => {
    expect(job.permissions).toEqual({
      contents: 'read',
      packages: 'write',
      'id-token': 'write',
      attestations: 'write',
    });
    const used = steps.map(action).filter(Boolean);
    expect(new Set(used)).toEqual(
      new Set(['actions/download-artifact', 'docker/login-action', 'actions/attest'])
    );
  });

  test('both registries get provenance; GHCR stores it next to the image', () => {
    expect(steps[ghcr].with).toEqual({
      'subject-name': GHCR,
      'subject-digest': GHCR_DIGEST,
      'push-to-registry': true,
      'create-storage-record': false,
    });
    expect(steps[hub].with).toEqual({
      'subject-name': 'docker.io/egeominotti/bunqueue',
      'subject-digest': '${{ steps.digests.outputs.hub }}',
      'create-storage-record': false,
    });
  });

  test('the SBOM is attested to the digest it was generated from', () => {
    expect(steps[sbom].with).toEqual({
      'subject-name': GHCR,
      'subject-digest': GHCR_DIGEST,
      'sbom-path': '/tmp/attest/sbom.cdx.json',
      'push-to-registry': true,
      'create-storage-record': false,
    });
  });
});

describe('release archive attestations', () => {
  const job = ci.jobs.release;
  const steps = job.steps ?? [];
  const prepare = named(job, 'Prepare release assets');
  const attest = named(job, 'Attest the release archives');
  const create = named(job, 'Create Release');

  test('the release job may sign archives', () => {
    expect(job.permissions).toEqual({
      contents: 'write',
      'id-token': 'write',
      attestations: 'write',
    });
  });

  test('every published archive is attested before the release is created', () => {
    expect(prepare).toBeGreaterThan(-1);
    expect(attest).toBeGreaterThan(prepare);
    expect(create).toBeGreaterThan(attest);
    expect(action(steps[attest])).toBe('actions/attest');
    const subjects = String(steps[attest].with?.['subject-path']).trim().split('\n');
    expect(subjects).toEqual(['release/bunqueue-*.tar.gz', 'release/bunqueue-*.zip']);
    const files = String(steps[create].with?.files);
    for (const archive of files.match(/release\/bunqueue-[^\s]+/g) ?? []) {
      expect(archive.endsWith('.tar.gz') || archive.endsWith('.zip')).toBe(true);
    }
  });

  test('release notes tell users how to verify artifacts', () => {
    const body = String(steps[create].with?.body);
    expect(body).toContain('gh attestation verify <archive> --repo');
    expect(body).toContain('gh attestation verify oci://ghcr.io/');
    expect(body).toContain('--predicate-type https://cyclonedx.org/bom');
  });
});
