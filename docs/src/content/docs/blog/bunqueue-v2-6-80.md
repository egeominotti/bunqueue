---
title: "bunqueue v2.6.80"
description: "Fixes 1 bug. Issue #64 follow-up: Jobs no longer lost from in-memory queue when markActive() fails during pull."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-80.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-25"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.80</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Issue #64 follow-up: Jobs no longer lost from in-memory queue when markActive() fails during pull.</p>
</div>

#### To install bunqueue v2.6.80

```bash title="bun"
bun add bunqueue@2.6.80
```

```bash title="npm"
npm install bunqueue@2.6.80
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Issue #64 follow-up**: Jobs no longer lost from in-memory queue when `markActive()` fails during pull. Previously, if SQLite threw a disk I/O error during `moveToProcessing()`, the job was already popped from the priority queue but never delivered to the worker, silently stuck in "waiting" state forever. `markActive()` is now non-fatal (persistence failure doesn't block processing), and a safety-net `requeueJob()` restores jobs to the queue if `moveToProcessing()` fails for any reason

---

[← bunqueue v2.6.79](/blog/bunqueue-v2-6-79/) · [Full changelog](/changelog/) · [All posts](/blog/)
