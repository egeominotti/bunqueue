---
title: "bunqueue v2.6.32"
description: "13 new WebSocket/SSE events, monitoring checks, cron overlap detection, flow lifecycle events."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-32.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-16"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.32</em></h1>
  <p class="bq-hero-sub">13 new WebSocket/SSE events, monitoring checks, cron overlap detection, flow lifecycle events.</p>
</div>

#### To install bunqueue v2.6.32

```bash title="bun"
bun add bunqueue@2.6.32
```

```bash title="npm"
npm install bunqueue@2.6.32
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## 13 new WebSocket/SSE events

`job:expired`, `flow:completed`, `flow:failed`, `queue:idle`, `queue:threshold`, `worker:overloaded`, `worker:error`, `cron:skipped`, `storage:size-warning`, `server:memory-warning` (+ `flow:*` wildcard). Total event types: 86.

## Monitoring checks

Periodic threshold monitoring runs on cleanup interval (10s). Configurable via env vars: `QUEUE_IDLE_THRESHOLD_MS`, `QUEUE_SIZE_THRESHOLD`, `MEMORY_WARNING_MB`, `STORAGE_WARNING_MB`, `WORKER_OVERLOAD_THRESHOLD_MS`.

## Cron overlap detection

Crons skip execution if the previous instance fired within 80% of the repeat interval, emitting `cron:skipped` instead.

## Flow lifecycle events

`flow:completed` when all children of a parent job finish, `flow:failed` when a child permanently fails (moves to DLQ).

## Changes

- **SandboxedWorker docs**: Clearly marked as experimental across all documentation pages (worker, migration, CPU-intensive, stall-detection, troubleshooting). Production recommendation to use standard `Worker` instead.

---

[← bunqueue v2.6.31](/blog/bunqueue-v2-6-31/) · [Full changelog](/changelog/) · [All posts](/blog/)
