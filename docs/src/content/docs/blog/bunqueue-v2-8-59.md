---
title: "bunqueue v2.8.59"
description: "Fixes 1 bug. Fixed the order-dependent Linux release failure where the in-memory Workflow loop suite left the process-wide embedded manager alive before a SQLite-backed timeout regression selected its database."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-59.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-08-05"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.59</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Fixed the order-dependent Linux release failure where the in-memory Workflow loop suite left the process-wide embedded manager alive before a SQLite-backed timeout regression selected its database.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.59

```bash title="bun"
bun add bunqueue@2.8.59
```

```bash title="npm"
npm install bunqueue@2.8.59
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Distribution

- GHCR releases now publish the exact package version tag alongside `latest`,
  the commit SHA, and the timestamp tag. Generated GitHub release instructions
  use the immutable version tag, so npm and container deployments can be pinned
  together. This completes the container publication that 2.8.58 missed when
  its unit gate failed; runtime behavior is unchanged from the verified 2.8.58
  Worker polling fix.

## Bugfixes

- Fixed the order-dependent Linux release failure where the in-memory Workflow
  loop suite left the process-wide embedded manager alive before a
  SQLite-backed timeout regression selected its database. Both suites now
  claim and release the singleton explicitly, and a child-process regression
  locks the exact file order that blocked the 2.8.58 release gate.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.58](/blog/bunqueue-v2-8-58/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.59) · [Commits since v2.8.57](https://github.com/egeominotti/bunqueue/compare/v2.8.57...v2.8.59) · [Full changelog](/changelog/) · [All posts](/blog/)
