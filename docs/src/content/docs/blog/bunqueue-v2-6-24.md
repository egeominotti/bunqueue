---
title: "bunqueue v2.6.24"
description: "Fixes 3 bugs. Per-queue totalCompleted/totalFailed counters, GET /queues/:q/workers endpoint, GET /queues/:q/dlq/stats endpoint, worker concurrency, status, currentJob fields and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-24.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.24</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. Per-queue totalCompleted/totalFailed counters, GET /queues/:q/workers endpoint, GET /queues/:q/dlq/stats endpoint, worker concurrency, status, currentJob fields and more.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.24

```bash title="bun"
bun add bunqueue@2.6.24
```

```bash title="npm"
npm install bunqueue@2.6.24
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Per-queue `totalCompleted`/`totalFailed` counters

`GET /queues/:q/counts` now includes cumulative per-queue counters for completed and failed jobs.

## `GET /queues/:q/workers` endpoint

New endpoint to list workers registered for a specific queue.

## `GET /queues/:q/dlq/stats` endpoint

Server-side DLQ stats aggregation: `total`, `byReason`, `pendingRetry`, `oldestEntry`.

## Worker `concurrency`, `status`, `currentJob` fields

`GET /workers` and `POST /workers` responses now include `concurrency`, computed `status` (active/stale), and `currentJob`.

## Throughput rates in `GET /stats`

Added `pushPerSec`, `pullPerSec`, `completePerSec`, `failPerSec` from the built-in throughput tracker.

## Bugfixes

- **Per-queue completed count**: `GET /queues/:q/counts` `completed` field now counts only jobs completed in the requested queue instead of returning the global total across all queues.
- **DLQ endpoint returns full metadata**: `GET /queues/:q/dlq` now returns `DlqEntry[]` with `enteredAt`, `reason`, `error`, `retryCount`, `lastRetryAt`, `nextRetryAt`, `expiresAt` instead of raw `Job[]`.
- **Worker registration accepts `queue` (singular)**: `POST /workers` now accepts both `queue` (string) and `queues` (array), plus `workerId` as alias for `name`.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.23](/blog/bunqueue-v2-6-23/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.24) · [Commits since v2.6.23](https://github.com/egeominotti/bunqueue/compare/v2.6.23...v2.6.24) · [Full changelog](/changelog/) · [All posts](/blog/)
