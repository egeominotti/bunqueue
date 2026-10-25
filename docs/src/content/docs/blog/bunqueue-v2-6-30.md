---
title: "bunqueue v2.6.30"
description: "Full WebSocket/SSE event coverage, new event categories, backup events, connection tracking and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-30.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.30</em></h1>
  <p class="bq-hero-sub">Full WebSocket/SSE event coverage, new event categories, backup events, connection tracking and more.</p>
</div>

#### To install bunqueue v2.6.30

```bash title="bun"
bun add bunqueue@2.6.30
```

```bash title="npm"
npm install bunqueue@2.6.30
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Full WebSocket/SSE event coverage

73 unique event types now emitted across all transports. Every state change, operation, and lifecycle event is observable via WebSocket pub/sub and SSE.

## New event categories

`job:timeout`, `job:lock-expired`, `job:deduplicated`, `job:waiting-children`, `job:dependencies-resolved`, `job:stalled` (dashboard), `job:moved-to-delayed`

## Backup events

`storage:backup-started`, `storage:backup-completed`, `storage:backup-failed`

## Connection tracking

`client:connected`, `client:disconnected`, `auth:failed`

## Batch events

`batch:pushed`, `batch:pulled`

## DLQ maintenance events

`dlq:auto-retried`, `dlq:expired`

## Cron lifecycle

`cron:fired`, `cron:missed`, `cron:updated` (distinguish create vs update)

## Worker events

`worker:heartbeat`, `worker:idle`, `worker:removed-stale`

## Webhook events

`webhook:fired`, `webhook:failed`, `webhook:enabled`, `webhook:disabled`

## Queue lifecycle

`queue:created`, `queue:removed` (on obliterate and cleanup)

## Rate/concurrency

`ratelimit:hit`, `ratelimit:rejected`, `concurrency:rejected`

## Server lifecycle

`server:started`, `server:shutdown`, `server:recovered`

## Cleanup events

`cleanup:orphans-removed`, `cleanup:stale-deps-removed`

## Memory

`memory:compacted`

---

[← bunqueue v2.6.29](/blog/bunqueue-v2-6-29/) · [Full changelog](/changelog/) · [All posts](/blog/)
