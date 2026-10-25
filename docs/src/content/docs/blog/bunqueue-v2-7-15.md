---
title: "bunqueue v2.7.15"
description: "Fixes 1 bug. Cron/scheduler jobs ignored job options (#86): Jobs spawned by upsertJobScheduler/cron always used JOB_DEFAULTS (maxAttempts: 3, removeOnFail: false), ignoring both the scheduler job template opts and the Queue…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-15.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-05-26"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.15</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Cron/scheduler jobs ignored job options (#86): Jobs spawned by upsertJobScheduler/cron always used JOB_DEFAULTS (maxAttempts: 3, removeOnFail: false), ignoring both the scheduler job template opts and the Queue…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.15

```bash title="bun"
bun add bunqueue@2.7.15
```

```bash title="npm"
npm install bunqueue@2.7.15
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Cron/scheduler jobs ignored job options (#86)**: Jobs spawned by `upsertJobScheduler`/cron always used `JOB_DEFAULTS` (`maxAttempts: 3`, `removeOnFail: false`), ignoring both the scheduler job template `opts` and the Queue `defaultJobOptions`. A scheduler with `attempts: 1, removeOnFail: true` still retried 3× and landed failed jobs in the DLQ. Cron definitions now carry a `jobOptions` field (`maxAttempts`, `backoff`, `timeout`, `delay`, `stallTimeout`, `removeOnComplete`, `removeOnFail`) that `fireCronJob` forwards into each spawned job. The client merges Queue `defaultJobOptions` (base) with per-scheduler template `opts` (override), mapping `attempts` → `maxAttempts`. Persisted via new `job_options` column (schema migration 12); old rows load as `null` and fall back to defaults.

## Notes

- For cron jobs, `removeOnComplete`/`removeOnFail` honor only the boolean form. The numeric/`KeepJobs` variants accepted by `queue.add()` are not applied to scheduler-spawned jobs and fall back to `false`.
- A per-job `delay` set in scheduler options stacks on top of the cron fire time (the spawned job is delayed `delay` ms after each scheduled fire).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.14](/blog/bunqueue-v2-7-14/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.15) · [Commits since v2.7.14](https://github.com/egeominotti/bunqueue/compare/v2.7.14...v2.7.15) · [Full changelog](/changelog/) · [All posts](/blog/)
