---
title: "bunqueue v2.6.104"
description: "Fixes 1 bug. Stall detector no longer re-queues cron jobs: the stall detection system (both retry and DLQ paths) now discards cron jobs with preventOverlap instead of re-queuing or moving them to DLQ."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-104.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.104</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Stall detector no longer re-queues cron jobs: the stall detection system (both retry and DLQ paths) now discards cron jobs with preventOverlap instead of re-queuing or moving them to DLQ.</p>
</div>

#### To install bunqueue v2.6.104

```bash title="bun"
bun add bunqueue@2.6.104
```

```bash title="npm"
npm install bunqueue@2.6.104
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Stall detector no longer re-queues cron jobs**: the stall detection system (both retry and DLQ paths) now discards cron jobs with `preventOverlap` instead of re-queuing or moving them to DLQ. This was the third code path that could cause cron jobs to fire immediately after client disconnect (fixes #73).

---

[← bunqueue v2.6.103](/blog/bunqueue-v2-6-103/) · [Full changelog](/changelog/) · [All posts](/blog/)
