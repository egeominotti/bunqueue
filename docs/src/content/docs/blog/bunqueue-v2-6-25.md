---
title: "bunqueue v2.6.25"
description: "Fixes 1 bug. GET /queues/:q/workers crash: Fixed crash when some workers were registered without a queues field (undefined/null)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-25.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-14"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.25</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. GET /queues/:q/workers crash: Fixed crash when some workers were registered without a queues field (undefined/null).</p>
</div>

#### To install bunqueue v2.6.25

```bash title="bun"
bun add bunqueue@2.6.25
```

```bash title="npm"
npm install bunqueue@2.6.25
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **`GET /queues/:q/workers` crash**: Fixed crash when some workers were registered without a `queues` field (`undefined`/`null`). Now safely skips workers with missing queues and defaults to `[]` on creation.

---

[← bunqueue v2.6.24](/blog/bunqueue-v2-6-24/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.25) · [Commits since v2.6.24](https://github.com/egeominotti/bunqueue/compare/v2.6.24...v2.6.25) · [Full changelog](/changelog/) · [All posts](/blog/)
