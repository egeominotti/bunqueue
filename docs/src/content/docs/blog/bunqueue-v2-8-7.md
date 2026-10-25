---
title: "bunqueue v2.8.7"
description: "Fixes 18 bugs. GET /queues/:q/jobs/list?status=<state> ignored the filter, only state was read, so it returned the whole queue regardless of the requested state (#95)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-7.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-07"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.7</em></h1>
  <p class="bq-hero-sub">Fixes 18 bugs. GET /queues/:q/jobs/list?status=&lt;state&gt; ignored the filter, only state was read, so it returned the whole queue regardless of the requested state (#95).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.7

```bash title="bun"
bun add bunqueue@2.8.7
```

```bash title="npm"
npm install bunqueue@2.8.7
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

A full audit of the HTTP REST API (every endpoint) and the TCP protocol (all 81
commands + client SDK), triggered by #95, surfaced a class of silent bugs where one
layer dropped or renamed a parameter so a documented feature was quietly ignored, the
call "succeeded" but did the wrong thing. Every confirmed case is fixed and verified by
an exhaustive live end-to-end run (91 HTTP checks, all 81 TCP commands) plus unit tests.

**HTTP routes**

- `GET /queues/:q/jobs/list?status=<state>` ignored the filter, only `state` was read,
  so it returned the whole queue regardless of the requested state (#95). Now accepts
  `status`, `state`, and `states`, each repeatable and comma-separated.
- `POST /jobs/:id/ack` and `POST /jobs/:id/fail` dropped the `token` (lock ownership) field.
- `PUT /jobs/:id/priority` dropped `lifo` (tie-break ordering).
- `POST /crons` dropped `immediately`, `skipIfNoWorker`, `preventOverlap`, and `jobOptions`.
- CORS headers were missing on `/health`, `/healthz`, `/live`, `/ready`, `/prometheus`,
  `/gc`, and `/heapstats`, so browser dashboards on another origin could not read them.

**TCP protocol / client SDK**

- **`ExtendLocks`** (batch lock renewal): the client sent a singular `duration` but the
  handler reads a per-id `durations[]` array, and read `extended` from a response that
  returns `count`, batch lock renewal silently kept the old TTL.
- **`RetryDlq`**: the client sent `id` but the handler reads `jobId`, so retrying a single
  DLQ entry retried the **entire** DLQ.
- **`PromoteJobs`**: the client read `promoted` from a response that returns `count`, so it
  always reported 0 promoted jobs.
- **`Clean`**: the client sent `type` but the handler reads `state`, so the state filter
  was ignored.
- **`UnrecoverableError` over TCP**: the `unrecoverable` flag on FAIL was dropped
  server-side, so unrecoverable jobs were retried per their `maxAttempts` instead of
  failing immediately (worked only in embedded mode).
- Worker **`lockDuration`** was never sent as `lockTtl` on PULL, so the server always used
  its 30s default regardless of the configured value.
- **`GetLogs`** ignored the `start`/`end` pagination parameters the client already sent.
- Scheduled (cron) jobs dropped **`priority`**.

**Counts consistency**

- `getJobCounts`/`getStats` undercounted `waiting-children`: jobs blocked on `dependsOn`
  (`waitingDeps`) report state `waiting-children` and appear in
  `getJobs({ state: 'waiting-children' })`, but were omitted from the count. The count now
  matches the reported state and the listed jobs.

**Config input validation & hardening**

- Config endpoints no longer break on non-numeric input. `SetStallConfig`/`SetDlqConfig`
  coerce numeric strings and drop non-numeric garbage (so the manager keeps its default)
  , previously a string `stallInterval` reached numeric comparisons as `NaN` and silently
  **disabled stall detection** for the queue. `RateLimit`/`SetConcurrency` now reject a
  non-finite `limit` instead of storing `NaN`.
- `PUT /queues/:q/concurrency` now accepts the natural `concurrency` field as well as
  `limit` (sending `{ "concurrency": N }` previously silently did nothing).
- `GET /queues/:q/dlq` supports optional `?limit`/`?offset` pagination and returns `total`.
- The `Cron` response now echoes the job `priority`; a single `PULL` no longer sends a
  redundant batch `count`.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.6](/blog/bunqueue-v2-8-6/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.7) · [Commits since v2.8.6](https://github.com/egeominotti/bunqueue/compare/v2.8.6...v2.8.7) · [Full changelog](/changelog/) · [All posts](/blog/)
