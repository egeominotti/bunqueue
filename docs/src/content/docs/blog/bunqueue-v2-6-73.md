---
title: "bunqueue v2.6.73"
description: "Job timeline tracking, timeline SQLite persistence, cloud snapshot: timeline field, cloud snapshot: failed job duration enrichment."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-73.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-23"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.73</em></h1>
  <p class="bq-hero-sub">Job timeline tracking, timeline SQLite persistence, cloud snapshot: timeline field, cloud snapshot: failed job duration enrichment.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.73

```bash title="bun"
bun add bunqueue@2.6.73
```

```bash title="npm"
npm install bunqueue@2.6.73
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Job timeline tracking

Every job now records a `timeline: JobTimelineEntry[]` array that tracks all state transitions (`waiting`, `active`, `completed`, `failed`, `delayed`, `prioritized`, `waiting-children`) with timestamps, error messages, and attempt numbers. Max 20 entries per job.

## Timeline SQLite persistence

Job timeline is persisted as a msgpack BLOB column in SQLite (schema v7 migration). Timeline survives server restarts and is available for DB-loaded jobs.

## Cloud snapshot: timeline field

`recentJobs[]` in cloud snapshots now includes `timeline` when present, giving the dashboard exact state-transition history for each job.

## Cloud snapshot: failed job duration enrichment

Failed jobs in `recentJobs[]` are now enriched with `duration`, `completedAt`, and `totalDuration` from DLQ attempt history, since `completedAt` is null for failed jobs.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.72](/blog/bunqueue-v2-6-72/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.73) · [Commits since v2.6.72](https://github.com/egeominotti/bunqueue/compare/v2.6.72...v2.6.73) · [Full changelog](/changelog/) · [All posts](/blog/)
