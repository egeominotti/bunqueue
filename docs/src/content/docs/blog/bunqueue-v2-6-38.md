---
title: "bunqueue v2.6.38"
description: "Worker registration + heartbeat system, registerWorkerCommand extended, heartbeatCommand extended, onOutcome callback in processor."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-38.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-18"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.38</em></h1>
  <p class="bq-hero-sub">Worker registration + heartbeat system, registerWorkerCommand extended, heartbeatCommand extended, onOutcome callback in processor.</p>
</div>

#### To install bunqueue v2.6.38

```bash title="bun"
bun add bunqueue@2.6.38
```

```bash title="npm"
npm install bunqueue@2.6.38
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Removed

- Flaky embedded tests (sandboxed-workers, cron-event-driven, query-operations)

## Worker registration + heartbeat system

Worker SDK now auto-registers with the server on `run()`, sends periodic heartbeats with `activeJobs`/`processed`/`failed` stats, and unregisters on `close()`. The server tracks `hostname`, `pid`, `uptime` per worker. `GET /workers` and `ListWorkers` TCP command return full worker details including aggregate stats. Dashboard receives real-time events (`worker:connected`, `worker:heartbeat`, `worker:disconnected`).

## `RegisterWorkerCommand` extended

Accepts `workerId`, `hostname`, `pid`, `startedAt` from client. Re-registration with same `workerId` updates instead of duplicating.

## `HeartbeatCommand` extended

Accepts `activeJobs`, `processed`, `failed` to sync client-side stats to server.

## `onOutcome` callback in processor

Tracks completed/failed counts without adding event listeners.

---

[← bunqueue v2.6.37](/blog/bunqueue-v2-6-37/) · [Full changelog](/changelog/) · [All posts](/blog/)
