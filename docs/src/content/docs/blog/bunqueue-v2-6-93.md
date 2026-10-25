---
title: "bunqueue v2.6.93"
description: "Fixes 1 bug. Deduplication bypass while job is active: handleDeduplication now checks jobIndex for active/processing jobs, not just the priority queue."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-93.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-31"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.93</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Deduplication bypass while job is active: handleDeduplication now checks jobIndex for active/processing jobs, not just the priority queue.</p>
</div>

#### To install bunqueue v2.6.93

```bash title="bun"
bun add bunqueue@2.6.93
```

```bash title="npm"
npm install bunqueue@2.6.93
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Deduplication bypass while job is active**: `handleDeduplication` now checks `jobIndex` for active/processing jobs, not just the priority queue. Previously, pushing a job with the same `uniqueKey` while the original was still being processed would create a duplicate. Also fixed `pushJob` fall-through when dedup returned `skip: true` but the job wasn't in the queue (active). Fixes #69.

---

[← bunqueue v2.6.92](/blog/bunqueue-v2-6-92/) · [Full changelog](/changelog/) · [All posts](/blog/)
