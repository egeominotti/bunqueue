---
title: "bunqueue v2.6.18"
description: "WebSocket pub/sub system with 50 event types, periodic dashboard broadcasts, queue:counts event, dashboard event hooks."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-18.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.18</em></h1>
  <p class="bq-hero-sub">WebSocket pub/sub system with 50 event types, periodic dashboard broadcasts, queue:counts event, dashboard event hooks.</p>
</div>

#### To install bunqueue v2.6.18

```bash title="bun"
bun add bunqueue@2.6.18
```

```bash title="npm"
npm install bunqueue@2.6.18
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## WebSocket pub/sub system with 50 event types

Clients subscribe to specific events via `{ cmd: "Subscribe", events: ["job:*", "stats:snapshot"] }` and receive only matching data. Supports wildcard patterns (`*`, `job:*`, `queue:*`, `worker:*`, `dlq:*`, `cron:*`, etc.). Legacy clients (no Subscribe) continue receiving all events in the old format.

## Periodic dashboard broadcasts

`stats:snapshot` every 5s (global stats, per-queue counts, throughput, workers), `health:status` every 10s (uptime, memory, connections), `storage:status` every 30s (collection sizes, disk health).

## `queue:counts` event

Fired on every job state change with real-time counts for the affected queue. Eliminates the N+1 polling problem for dashboards (20 queues = 0 HTTP calls instead of 200+/min).

## Dashboard event hooks

30+ operations now emit real-time events: `job:promoted`, `job:discarded`, `job:priority-changed`, `job:data-updated`, `job:delay-changed`, `queue:paused/resumed/drained/cleaned/obliterated`, `dlq:retried/purged`, `cron:created/deleted`, `webhook:added/removed`, `ratelimit:set/cleared`, `concurrency:set/cleared`, `config:stall-changed/dlq-changed`, `worker:connected/disconnected`.

## Changes

- **HTTP API docs rewritten**: 2,048 lines of enterprise-grade documentation with deep explanations of job lifecycle, retry behavior, stall detection, every endpoint with curl examples, full request/response specs, all 50 pub/sub events with payload schemas.

---

[← bunqueue v2.6.17](/blog/bunqueue-v2-6-17/) · [Full changelog](/changelog/) · [All posts](/blog/)
