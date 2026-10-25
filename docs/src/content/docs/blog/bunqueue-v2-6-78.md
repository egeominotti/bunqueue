---
title: "bunqueue v2.6.78"
description: "Fixes 3 bugs. skipMissedOnRestart."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-78.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.78</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. skipMissedOnRestart.</p>
</div>

#### To install bunqueue v2.6.78

```bash title="bun"
bun add bunqueue@2.6.78
```

```bash title="npm"
npm install bunqueue@2.6.78
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## `skipMissedOnRestart`

Option for cron jobs, when enabled, cron jobs that were missed during server downtime are skipped and rescheduled to the next future run instead of being executed immediately on restart. Default: `false` (preserves existing catch-up behavior)

## More additions

- Schema migration v8: `skip_missed_on_restart` column on `cron_jobs` table

## Bugfixes

- **Issue #61**: `JobTemplate` is now generic `JobTemplate<T>`, `data` field correctly inherits the Queue's type parameter instead of being `unknown`. Fixed incorrect docs in `use-cases` showing `data` in the second parameter instead of the third. Exported `RepeatOpts`, `JobTemplate`, `SchedulerInfo` types from `bunqueue/client`
- **Issue #63**: Cloud dashboard `queue:detail` response now includes `enabled` field in `stallConfig`, allowing the dashboard to properly display and toggle stall detection
- **Issue #64**: Added WAL checkpoint (`PRAGMA wal_checkpoint(TRUNCATE)`) before `db.close()` to prevent stale locks and `disk I/O error` on rapid restarts in embedded mode

---

[← bunqueue v2.6.77](/blog/bunqueue-v2-6-77/) · [Full changelog](/changelog/) · [All posts](/blog/)
