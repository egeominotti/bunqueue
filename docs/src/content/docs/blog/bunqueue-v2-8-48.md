---
title: "bunqueue v2.8.48"
description: "Fixes 4 bugs. bun run check:docs-data."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-48.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-30"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.48</em></h1>
  <p class="bq-hero-sub">Fixes 4 bugs. bun run check:docs-data.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

Three CI failures fixed, each of which could only ever fail in CI. No runtime behaviour
changed: this release touches `.gitignore`, two workflows, `scripts/`, `test/`,
documentation, and `package.json` (version plus one new script entry) only.

#### To install bunqueue v2.8.48

```bash title="bun"
bun add bunqueue@2.8.48
```

```bash title="npm"
npm install bunqueue@2.8.48
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## `bun run check:docs-data`

(`scripts/check-docs-data.ts`), wired into the CI docs
job ahead of the build and into `bun run check`. It asserts that every relative module
specifier (`from`, side-effect `import`, dynamic `import()`, `require`) and asset
reference (markdown image, `src=`) in `docs/src/content/docs/**` resolves to a
git-tracked file, and that the committed `apiVersions.json` still equals what the
generator would derive from `package.json` and `docs/public/reference/` — including
that the tree for the current version is itself tracked, or the published listing
would link to a 404. All of these are invisible locally: an ignored import resolves on
the author's disk, and a stale version list still builds. Fenced and inline code is
stripped before scanning, so a page that documents a relative import in a sample is
not mistaken for one. A `dev` entry is rejected outright so a local `--dev` preview
cannot be published. Note that a **minor** bump now fails the check until
`bun run docs:api` output is committed; patch bumps are unaffected.
Scanners are unit-tested in `test/check-docs-data.test.ts`. `docs/src/components/**`
is scanned as well, since a component importing an ignored file fails the build
identically, and every existing extension candidate for a specifier is checked rather
than the first, so a stale untracked `x.js` cannot hide behind a tracked `x.ts`.

## More additions

- **`test/sdk-ci-workflow.test.ts` now asserts the soak invariants instead of a literal
  env string.** It parses `sdk.yml` and requires that `RUN_SOAK` and
  `RATE_LIMIT_MAX_REQUESTS` derive from the same condition, that all seven soak/fuzz
  steps share the gate, that the Go and Elixir soaks carry the duration derivation and
  its preconditions, and that every job bounds its own runtime.

## Changes

- **The SDK soak profiles can now be run on demand.** `.github/workflows/sdk.yml` gains
  `workflow_dispatch` with a `run_soak` input; previously the soak steps (and the Go
  native fuzzing step, now gated the same way) ran on `schedule` alone, so a fix to them
  could not be exercised before the next Sunday.
  `RATE_LIMIT_MAX_REQUESTS` is derived from the same condition as the soak gate — a
  manual soak run with the push-level limit would measure the broker's anti-abuse
  throttle instead of the client.
- **Every SDK job now has a `timeout-minutes` bound** (45, or 50 where a soak and
  fuzzing share the job). They previously inherited the 360-minute runner default, so a
  wedge outside any test framework — dependency resolution, a broker that never binds, a
  hung conformance driver — burned six hours of runner time.

## Bugfixes

- **The docs site could not build from a clean checkout.** `.gitignore` excluded `data/`
  for runtime SQLite directories, and that pattern also matched `docs/src/data/`, so the
  generated `apiVersions.json` that `reference.mdx` imports was never committed. Local
  builds succeeded from the file on disk; CI failed with
  `Could not resolve "../../data/apiVersions.json"`. The ignore rule now carries an
  explicit `!docs/src/data/` negation (a directory negation — git cannot re-include a
  file inside an excluded directory) and the file is tracked.
- **The weekly Go SDK soak had never once completed.** `go test` panics at its own
  10-minute default, which is shorter than the 15-minute soak profile, so the job died at
  `panic: test timed out after 10m0s` every week regardless of client behaviour.
- **The weekly Elixir SDK soak died 60 seconds in.** ExUnit kills a test at 60 s by
  default: `** (ExUnit.TimeoutError) test timed out after 60000ms`. Only the
  Elixir 1.20.1 leg was affected because the soak step is gated to that matrix entry.
- **"all versions" linked to the wrong place on 234 API-reference pages.**
  `scripts/build-api-reference.ts` called its two-parameter `banner()` with three
  arguments, so the depth parameter received a boolean, collapsed to `0`, and every page
  below the version root linked back to that version instead of `/reference/`. The link
  is now derived by `allVersionsHref(depth)`, the already-published pages were repaired
  in place, and `test/build-api-reference.test.ts` pins the arithmetic and the signature.
  `scripts/` is outside `tsconfig.json`'s `include`, which is why a three-argument call
  to a two-parameter function shipped in the first place.

  Both bounds are now derived from `BUNQUEUE_SDK_SOAK_SECONDS` plus 300 s of slack for
  broker startup and teardown, so raising the soak duration cannot silently reintroduce
  either failure. The expansion uses `${VAR:?}`: under GitHub's default `bash -e` (no
  `set -u`) an unset or renamed variable would otherwise expand to a 300-second bound —
  tighter than the default it replaces — and fail in exactly the way being fixed.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.47](/blog/bunqueue-v2-8-47/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.48) · [Commits since v2.8.46](https://github.com/egeominotti/bunqueue/compare/v2.8.46...v2.8.48) · [Full changelog](/changelog/) · [All posts](/blog/)
