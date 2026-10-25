---
title: "bunqueue v2.6.71"
description: "Fixes 6 bugs. BullMQ v5 prioritized state, bullMQ v5 waiting-children state, failParentOnFailure, flow atomicity and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-71.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.71</em></h1>
  <p class="bq-hero-sub">Fixes 6 bugs. BullMQ v5 prioritized state, bullMQ v5 waiting-children state, failParentOnFailure, flow atomicity and more.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.71

```bash title="bun"
bun add bunqueue@2.6.71
```

```bash title="npm"
npm install bunqueue@2.6.71
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## BullMQ v5 `prioritized` state

Jobs with `priority > 0` now report state `'prioritized'` instead of `'waiting'`, matching BullMQ v5 exactly. Affects `getJobState()`, `getJobCounts()`, Prometheus metrics, cloud snapshot, SSE/WebSocket events, and MCP adapter.

## BullMQ v5 `waiting-children` state

Parent jobs in flows correctly report `'waiting-children'` state while waiting for child jobs to complete.

## `failParentOnFailure`

When a child job terminally fails with `failParentOnFailure: true`, the parent job is automatically moved to `failed` state. Handles race conditions where child fails before parent linkage is established.

## Flow atomicity

`FlowProducer.add()` and `addBulk()` now automatically roll back all created jobs if any part of the flow fails during creation.

## `FlowOpts` with `queuesOptions`

Pass per-queue default job options as second argument to `flow.add(flowJob, { queuesOptions: { queueName: { attempts: 5 } } })`.

## FlowProducer extends EventEmitter

BullMQ v5 compatible. `close()` returns `Promise<void>`, `closing` property tracks shutdown, `disconnect()` alias.

## Job move operations

`moveActiveToWait`, `changeWaitingDelay`, `moveToWaitingChildren` state transitions with proper resource cleanup (concurrency slots, unique keys, group locks).

## Changes

- **Documentation**: Updated state machine diagrams, API types, FlowProducer guide, migration guide with BullMQ v5 parity tables, cloud contract with new snapshot fields.

## Bugfixes

- **TOCTOU in `moveParentToFailed`**: Re-checks `jobIndex` inside write lock to prevent duplicate DLQ entries when multiple children with `failParentOnFailure` fail concurrently.
- **Unhandled promise rejections**: `moveParentToFailed` calls now have `.catch()` handlers instead of fire-and-forget `void`.
- **SQLite `queryJobs(state='prioritized')`**: Translates `'prioritized'` to `WHERE state='waiting' AND priority > 0` since SQLite never stores 'prioritized' as a state value.
- **`moveActiveToWait` resource leak**: Now calls `releaseJobResources()` to free concurrency/uniqueKey/group slots before re-queueing.
- **Move operations handle `prioritized` state**: `moveJobToWait` and `moveJobToDelayed` now correctly handle jobs in `'prioritized'` state.
- **Cloud snapshot**: Added `prioritized` to stats and per-queue data. Per-queue data now uses `failed` instead of `dlq` (BullMQ v5 compatible).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.67](/blog/bunqueue-v2-6-67/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.71) · [Commits since v2.6.67](https://github.com/egeominotti/bunqueue/compare/v2.6.67...v2.6.71) · [Full changelog](/changelog/) · [All posts](/blog/)
