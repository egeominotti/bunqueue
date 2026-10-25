---
title: "bunqueue v2.6.110"
description: "Fixes 1 bug. Stacktrace now included in failed worker event: job.stacktrace was always null when a job threw an error."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-110.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-03"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.110</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Stacktrace now included in failed worker event: job.stacktrace was always null when a job threw an error.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.110

```bash title="bun"
bun add bunqueue@2.6.110
```

```bash title="npm"
npm install bunqueue@2.6.110
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Stacktrace now included in `failed` worker event**: `job.stacktrace` was always `null` when a job threw an error. Now correctly populated with the error's stack trace lines, respecting `stackTraceLimit` (default: 10). Fixes [#74](https://github.com/egeominotti/bunqueue/issues/74).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.109](/blog/bunqueue-v2-6-109/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.110) · [Commits since v2.6.109](https://github.com/egeominotti/bunqueue/compare/v2.6.109...v2.6.110) · [Full changelog](/changelog/) · [All posts](/blog/)
