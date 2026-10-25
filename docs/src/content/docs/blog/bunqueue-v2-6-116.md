---
title: "bunqueue v2.6.116"
description: "Fixes 1 bug. Deduplication broken for long-running scheduled jobs: cleanEmptyQueues() was deleting unique-key entries for queues whose priority queue was empty, even when jobs holding those keys were still actively processing."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-116.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-09"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.116</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Deduplication broken for long-running scheduled jobs: cleanEmptyQueues() was deleting unique-key entries for queues whose priority queue was empty, even when jobs holding those keys were still actively processing.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.116

```bash title="bun"
bun add bunqueue@2.6.116
```

```bash title="npm"
npm install bunqueue@2.6.116
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Deduplication broken for long-running scheduled jobs**: `cleanEmptyQueues()` was deleting unique-key entries for queues whose priority queue was empty, even when jobs holding those keys were still actively processing. This caused the dedup guard to be wiped every ~10 s (the cleanup interval), allowing `every()` / `cron()` to create duplicate jobs. The fix checks `processingShards` and `waitingDeps` before considering a queue "empty". Fixes [#80](https://github.com/egeominotti/bunqueue/issues/80).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.115](/blog/bunqueue-v2-6-115/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.116) · [Commits since v2.6.115](https://github.com/egeominotti/bunqueue/compare/v2.6.115...v2.6.116) · [Full changelog](/changelog/) · [All posts](/blog/)
