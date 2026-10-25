---
title: "bunqueue v2.4.8"
description: "Fixes 1 bug. getJobs({ state: 'completed' }) now correctly returns completed jobs instead of empty results"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-4-8.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-16"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.4.8</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. getJobs({ state: 'completed' }) now correctly returns completed jobs instead of empty results</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.4.8

```bash title="bun"
bun add bunqueue@2.4.8
```

```bash title="npm"
npm install bunqueue@2.4.8
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **`getJobs({ state: 'completed' })`** now correctly returns completed jobs instead of empty results

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.4.7](/blog/bunqueue-v2-4-7/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.4.8) · [Commits since v2.4.7](https://github.com/egeominotti/bunqueue/compare/v2.4.7...v2.4.8) · [Full changelog](/changelog/) · [All posts](/blog/)
