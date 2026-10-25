---
title: "bunqueue v2.1.2"
description: "Fixes 1 bug. Queue name consistency tests to prevent regression, monitoring documentation added to sidebar Production section."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-1-2.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-04"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.1.2</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Queue name consistency tests to prevent regression, monitoring documentation added to sidebar Production section.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.1.2

```bash title="bun"
bun add bunqueue@2.1.2
```

```bash title="npm"
npm install bunqueue@2.1.2
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- Queue name consistency tests to prevent regression
- Monitoring documentation added to sidebar Production section

## Changes

- Stats interval changed to 5 minutes with timestamp
- Removed verbose info/warn logs, keeping only errors
- Downgraded TypeScript to 5.7.3 for CI compatibility

## Bugfixes

- **Queue name consistency** - Fixed benchmark tests using different queue names for worker and queue in both embedded and TCP modes

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.1.1](/blog/bunqueue-v2-1-1/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.1.2) · [Commits since v2.1.1](https://github.com/egeominotti/bunqueue/compare/v2.1.1...v2.1.2) · [Full changelog](/changelog/) · [All posts](/blog/)
