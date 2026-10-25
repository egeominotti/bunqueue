---
title: "bunqueue v2.8.57"
description: "Fixed an order-dependent CI failure caused by a Workflow production test leaving the process-wide embedded manager initialized in memory."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-57.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-08-03"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.57</em></h1>
  <p class="bq-hero-sub">Fixed an order-dependent CI failure caused by a Workflow production test leaving the process-wide embedded manager initialized in memory.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.57

```bash title="bun"
bun add bunqueue@2.8.57
```

```bash title="npm"
npm install bunqueue@2.8.57
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Do not use 2.8.56

- **2.8.56 is broken. Install 2.8.57 or newer.** Its CI run was red — one unit
  test failed on embedded parent-dependency recovery across a broker restart —
  so the quality gate blocked the tag, release and image. Only the npm artifact
  exists, because it was pushed manually while the gate was failing. It is being
  deprecated on npm as part of this release, and unpublished as well if that
  happens inside npm's 72-hour window.

## CI and package verification

- Fixed an order-dependent CI failure caused by a Workflow production test
  leaving the process-wide embedded manager initialized in memory. Its teardown
  now pairs `Engine.close()` with `shutdownManager()`, preserving the documented
  shared-manager ownership contract while preventing the following durable
  parent restart test from using the wrong backend.
- Added an offline consumer test for the exact npm tarball. It verifies the
  manifest exports and imports `defineConfig` from `bunqueue`, Queue and Worker
  from `bunqueue/client`, and Engine from `bunqueue/workflow` after packing the
  release. The consumer unpacks the archive into its own `node_modules` and
  links only the declared dependencies, proving `croner` and `msgpackr` are
  enough for every entrypoint. The CLI and runtime remain Bun-only by design.
- Fixed the scheduled Go mutation job, which aborted before its first mutant
  because Bun was missing from `PATH` while the Go suite spawns a real broker.
- Cleared the weekly SDK advisory gate by overriding the TypeScript SDK's
  transitive `qs@6.15.1` (GHSA-q8mj-m7cp-5q26) to a patched `^6.15.2`. The
  override only affects the mutation toolchain; the published client has no
  `qs` dependency.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.56](/blog/bunqueue-v2-8-56/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.57) · [Commits since v2.8.55](https://github.com/egeominotti/bunqueue/compare/v2.8.55...v2.8.57) · [Full changelog](/changelog/) · [All posts](/blog/)
