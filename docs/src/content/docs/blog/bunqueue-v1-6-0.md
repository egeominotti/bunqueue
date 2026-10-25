---
title: "bunqueue v1.6.0"
description: "Fixes 1 bug. Stall Detection, advanced DLQ, worker Heartbeats, repeatable Jobs and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v1-6-0.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-01-19"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v1.6.0</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Stall Detection, advanced DLQ, worker Heartbeats, repeatable Jobs and more.</p>
</div>

#### To install bunqueue v1.6.0

```bash title="bun"
bun add bunqueue@1.6.0
```

```bash title="npm"
npm install bunqueue@1.6.0
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Stall Detection

Automatic recovery of unresponsive jobs
- Configurable stall interval and max stalls
- Grace period after job start
- Automatic retry or move to DLQ

## Advanced DLQ

Enhanced Dead Letter Queue
- Full metadata (reason, error, attempt history)
- Auto-retry with exponential backoff
- Filtering by reason, age, retriability
- Statistics endpoint
- Auto-purge expired entries

## Worker Heartbeats

Configurable heartbeat interval

## Repeatable Jobs

Support for recurring jobs with intervals or limits

## Flow Producer

Parent-child job relationships

## Queue Groups

Bulk operations across multiple queues

## Changes

- Updated banner to "written in TypeScript"
- Version now read from package.json dynamically

## Bugfixes

- DLQ entry return type consistency

---

[← bunqueue v1.5.0](/blog/bunqueue-v1-5-0/) · [Full changelog](/changelog/) · [All posts](/blog/)
