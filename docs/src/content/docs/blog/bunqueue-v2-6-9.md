---
title: "bunqueue v2.6.9"
description: "Fixes 1 bug. SandboxedWorker graceful stop: stop() now drains active jobs before terminating worker threads, preventing data loss when stopping during job processing."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-9.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-10"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.9</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. SandboxedWorker graceful stop: stop() now drains active jobs before terminating worker threads, preventing data loss when stopping during job processing.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.9

```bash title="bun"
bun add bunqueue@2.6.9
```

```bash title="npm"
npm install bunqueue@2.6.9
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **SandboxedWorker graceful stop**: `stop()` now drains active jobs before terminating worker threads, preventing data loss when stopping during job processing. Added `force` parameter for immediate termination when needed. ([#39](https://github.com/egeominotti/bunqueue/issues/39))

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.7](/blog/bunqueue-v2-6-7/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.9) · [Commits since v2.6.7](https://github.com/egeominotti/bunqueue/compare/v2.6.7...v2.6.9) · [Full changelog](/changelog/) · [All posts](/blog/)
