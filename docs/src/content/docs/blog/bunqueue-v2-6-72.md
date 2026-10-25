---
title: "bunqueue v2.6.72"
description: "Fixes 1 bug. Cloud snapshot: waiting-children state, cloud snapshot: prioritized state in job collection, cloud snapshot: worker computed fields, cloud snapshot: queueExtended and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-72.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.72</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Cloud snapshot: waiting-children state, cloud snapshot: prioritized state in job collection, cloud snapshot: worker computed fields, cloud snapshot: queueExtended and more.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.72

```bash title="bun"
bun add bunqueue@2.6.72
```

```bash title="npm"
npm install bunqueue@2.6.72
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Cloud snapshot: `waiting-children` state

Jobs in `waiting-children` state are now collected in `recentJobs[]` and counted in both global `stats` and per-queue `queues[]`. Dashboard can now display parent jobs waiting for children.

## Cloud snapshot: `prioritized` state in job collection

`recentJobs[]` now includes jobs with `state: 'prioritized'`. Previously only `waiting/active/delayed/failed/completed` were collected.

## Cloud snapshot: worker computed fields

`workerDetails[]` now includes `uptime` (ms since registration), `status` (`'active'|'idle'|'stalled'`), `errorRate` (0-1), and `utilization` (activeJobs/concurrency).

## Cloud snapshot: `queueExtended`

Per-queue extended telemetry: `uniqueKeys` (active dedup keys), `activeGroups` (FIFO groups), `waitingDeps` (jobs awaiting dependencies), `waitingChildren` (parents awaiting children).

## Cloud snapshot: `eventSubscribers`

Count of active event subscribers (SSE, WebSocket, internal).

## Cloud snapshot: `pendingDepChecks`

Number of dependency checks awaiting flush.

## TCP `GetJobCounts`: `waiting-children`

TCP protocol now returns `waiting-children` count in job counts response.

## Bugfixes

- **`getJobs()` with `state: 'waiting-children'`**: SQLite and in-memory query paths now correctly return jobs in `waitingDeps`/`waitingChildren` maps when filtering by `waiting-children` state.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.71](/blog/bunqueue-v2-6-71/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.72) · [Commits since v2.6.71](https://github.com/egeominotti/bunqueue/compare/v2.6.71...v2.6.72) · [Full changelog](/changelog/) · [All posts](/blog/)
