---
title: "bunqueue v2.1.8"
description: "Fixes 1 bug. 4 regression tests for batch push event emission fix."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-1-8.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-06"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.1.8</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. 4 regression tests for batch push event emission fix.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.1.8

```bash title="bun"
bun add bunqueue@2.1.8
```

```bash title="npm"
npm install bunqueue@2.1.8
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- 4 regression tests for batch push event emission fix

## Changes

- Navbar simplified to show only logo without title text

## Bugfixes

- **pushJobBatch event emission** - `pushJobBatch` was silently dropping event broadcasts, causing subscribers and webhooks to miss all batch-pushed jobs. Added broadcast loop after batch insert to match single `pushJob` behavior.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.1.7](/blog/bunqueue-v2-1-7/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.1.8) · [Commits since v2.1.6](https://github.com/egeominotti/bunqueue/compare/v2.1.6...v2.1.8) · [Full changelog](/changelog/) · [All posts](/blog/)
