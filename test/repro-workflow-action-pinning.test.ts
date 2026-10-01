/**
 * Regression: third-party GitHub Actions were referenced by mutable tags.
 *
 * Jobs holding `NPM_TOKEN`, `DOCKERHUB_TOKEN`, `packages: write`, and
 * `contents: write` ran `oven-sh/setup-bun@v2`, `docker/*@v3`, and
 * `softprops/action-gh-release@v2`. Whoever controls those tags controls the
 * code that runs next to the release credentials. Every non-local `uses:` must
 * name an immutable 40-hex commit and record the release it was resolved from.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';

type Step = { uses?: string; with?: Record<string, unknown> };
type Workflow = { jobs: Record<string, { uses?: string; steps?: Step[] }> };

const directory = `${import.meta.dir}/../.github/workflows`;
const files = readdirSync(directory)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort();
const PINNED = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(\/[^@\s]+)?@([0-9a-f]{40})$/;
const RELEASE = /^v?\d+\.\d+\.\d+$/;
// dtolnay/rust-toolchain has no releases: its branch name selects the toolchain,
// so a SHA pin must pass the toolchain explicitly and names the branch it came from.
const REF_NAMED_TOOLCHAIN = 'dtolnay/rust-toolchain';

const isLocal = (ref: string) => ref.startsWith('./');

async function inventory() {
  const parsed: Array<{ file: string; uses: string; step?: Step }> = [];
  const lines: Array<{ file: string; uses: string; comment: string }> = [];
  for (const file of files) {
    const text = await Bun.file(`${directory}/${file}`).text();
    const workflow = Bun.YAML.parse(text) as Workflow;
    for (const job of Object.values(workflow.jobs)) {
      if (job.uses) parsed.push({ file, uses: job.uses });
      for (const step of job.steps ?? []) {
        if (step.uses) parsed.push({ file, uses: step.uses, step });
      }
    }
    for (const line of text.split('\n')) {
      const match = /^\s*(?:-\s+)?uses:\s*(\S+)\s*(?:#\s*(.*?))?\s*$/.exec(line);
      if (match) lines.push({ file, uses: match[1], comment: match[2] ?? '' });
    }
  }
  return { parsed, lines };
}

const { parsed, lines } = await inventory();
const external = parsed.filter(({ uses }) => !isLocal(uses));

describe('third-party actions are pinned to immutable commits', () => {
  test('the inventory covers every workflow and every uses line', () => {
    expect(files).toEqual([
      'ci.yml',
      'sdk-mutation.yml',
      'sdk-release.yml',
      'sdk-security.yml',
      'sdk.yml',
    ]);
    expect(lines.map(({ file, uses }) => `${file} ${uses}`).sort()).toEqual(
      parsed.map(({ file, uses }) => `${file} ${uses}`).sort()
    );
    expect(external.length).toBeGreaterThan(50);
  });

  test('every non-local action references a full commit SHA', () => {
    const unpinned = external
      .filter(({ uses }) => !PINNED.test(uses))
      .map(({ file, uses }) => `${file}: ${uses}`);
    expect(unpinned).toEqual([]);
  });

  test('every pin names the exact release it was resolved from', () => {
    const missing = lines
      .filter(({ uses }) => !isLocal(uses))
      .filter(({ uses, comment }) =>
        uses.startsWith(`${REF_NAMED_TOOLCHAIN}@`) ? comment === '' : !RELEASE.test(comment)
      )
      .map(({ file, uses, comment }) => `${file}: ${uses} # ${comment}`);
    expect(missing).toEqual([]);
  });

  test('one action resolves to one commit and one release comment across all workflows', () => {
    const seen = new Map<string, string>();
    const drift: string[] = [];
    for (const { file, uses, comment } of lines.filter((line) => !isLocal(line.uses))) {
      const [name, ref] = uses.split('@');
      const pin = `${ref} # ${comment}`;
      const previous = seen.get(name);
      if (previous !== undefined && previous !== pin)
        drift.push(`${file}: ${name} ${pin} != ${previous}`);
      seen.set(name, previous ?? pin);
    }
    expect(drift).toEqual([]);
  });

  test('ref-selected Rust toolchains keep their previous toolchain as an explicit input', () => {
    const toolchains = external
      .filter(({ uses }) => uses.startsWith(`${REF_NAMED_TOOLCHAIN}@`))
      .map(({ file, step }) => `${file} ${String(step?.with?.toolchain ?? '<unset>')}`)
      .sort();
    // Previously selected as @1.85.0 (sdk.yml, sdk-mutation.yml) and @stable.
    expect(toolchains).toEqual([
      'sdk-mutation.yml 1.85.0',
      'sdk-security.yml stable',
      'sdk.yml 1.85.0',
    ]);
  });
});
