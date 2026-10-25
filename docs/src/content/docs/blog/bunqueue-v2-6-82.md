---
title: "bunqueue v2.6.82"
description: "Fixes 2 bugs. skipMissedOnRestart not working via Queue#upsertJobScheduler (#65): - CronScheduler.add() now preserves existing executions count when upserting a cron (previously reset to 0 on every call) - CronScheduler.load() now…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-82.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-26"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.82</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. skipMissedOnRestart not working via Queue#upsertJobScheduler (#65): - CronScheduler.add() now preserves existing executions count when upserting a cron (previously reset to 0 on every call) - CronScheduler.load() now…</p>
</div>

#### To install bunqueue v2.6.82

```bash title="bun"
bun add bunqueue@2.6.82
```

```bash title="npm"
npm install bunqueue@2.6.82
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **`skipMissedOnRestart` not working via `Queue#upsertJobScheduler`** ([#65](https://github.com/egeominotti/bunqueue/issues/65)):
  - `CronScheduler.add()` now preserves existing `executions` count when upserting a cron (previously reset to 0 on every call)
  - `CronScheduler.load()` now persists recalculated `nextRun` to the database when `skipMissedOnRestart` adjusts it
  - `immediately: true` option is now supported in `CronJobInput`, fires the cron immediately on creation, then continues on schedule
  - Wired `immediately` through `upsertJobScheduler` embedded path
- **Embedded `test-cron-event-driven` test hanging**: added `shutdownManager()` call to properly clean up the shared QueueManager singleton and its background task timers

---

[← bunqueue v2.6.81](/blog/bunqueue-v2-6-81/) · [Full changelog](/changelog/) · [All posts](/blog/)
