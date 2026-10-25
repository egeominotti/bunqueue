---
title: "bunqueue v2.6.66"
description: "Fixes 1 bug. Deduplication not working for JobScheduler (Issue #60): upsertJobScheduler accepted deduplication options in the JobTemplate but silently discarded them."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-66.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-22"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.66</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Deduplication not working for JobScheduler (Issue #60): upsertJobScheduler accepted deduplication options in the JobTemplate but silently discarded them.</p>
</div>

#### To install bunqueue v2.6.66

```bash title="bun"
bun add bunqueue@2.6.66
```

```bash title="npm"
npm install bunqueue@2.6.66
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Deduplication not working for JobScheduler (Issue #60)**: `upsertJobScheduler` accepted deduplication options in the `JobTemplate` but silently discarded them. The cron system (`CronJob`, `CronJobInput`, `cronScheduler`) had no fields for `uniqueKey` or `dedup`, so every cron tick created a new job regardless of deduplication settings. Now dedup options are stored in the cron job (including SQLite persistence with schema migration v6) and passed through to `pushJob()` on each tick. When a worker is slow or offline, only one job per dedup key exists instead of unbounded duplicates.

---

[← bunqueue v2.6.65](/blog/bunqueue-v2-6-65/) · [Full changelog](/changelog/) · [All posts](/blog/)
