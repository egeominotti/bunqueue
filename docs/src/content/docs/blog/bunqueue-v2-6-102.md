---
title: "bunqueue v2.6.102"
description: "Fixes 1 bug. Event subscription leak on HTTP server shutdown: queueManager.subscribe() returned an unsubscribe function that was discarded."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-102.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-02"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.102</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Event subscription leak on HTTP server shutdown: queueManager.subscribe() returned an unsubscribe function that was discarded.</p>
</div>

#### To install bunqueue v2.6.102

```bash title="bun"
bun add bunqueue@2.6.102
```

```bash title="npm"
npm install bunqueue@2.6.102
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Event subscription leak on HTTP server shutdown**: `queueManager.subscribe()` returned an unsubscribe function that was discarded. On `stop()`, the subscription remained active, preventing garbage collection. Now properly unsubscribed during shutdown.

---

[← bunqueue v2.6.101](/blog/bunqueue-v2-6-101/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.102) · [Commits since v2.6.101](https://github.com/egeominotti/bunqueue/compare/v2.6.101...v2.6.102) · [Full changelog](/changelog/) · [All posts](/blog/)
