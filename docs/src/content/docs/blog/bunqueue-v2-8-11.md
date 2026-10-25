---
title: "bunqueue v2.8.11"
description: "Fixes 6 bugs. FAIL now carries the stack (stack: string[], optional, old clients unaffected)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-11.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-12"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.11</em></h1>
  <p class="bq-hero-sub">Fixes 6 bugs. FAIL now carries the stack (stack: string[], optional, old clients unaffected).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.11

```bash title="bun"
bun add bunqueue@2.8.11
```

```bash title="npm"
npm install bunqueue@2.8.11
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

The 2.6.110 fix populated `job.stacktrace` only on the worker's in-process
`failed` event object. The stack never reached the server: `FAIL` carried just
the error message, so `queue.getJob(id).stacktrace` was always `null` (the
TCP job proxy even hardcoded it), DLQ entries had no stack, and any process
other than the failing worker could never see it. Reported again on #74
("I need the stacktrace").

- **`FAIL` now carries the stack** (`stack: string[]`, optional, old clients
  unaffected). The worker sends the failure's stack lines alongside the error
  message in both TCP and embedded mode.
- **Persisted on the job**: the last failure's stack is stored on the domain
  job (trimmed lines, capped at `stackTraceLimit`, default 10), survives
  retries and server restarts (new `jobs.stacktrace` column, migration 13),
  and rides into the DLQ entry when attempts are exhausted.
- **Readable everywhere**: `queue.getJob()` / `getJobs()` now return the real
  `stacktrace` (TCP + embedded, the proxy no longer hardcodes `null`), DLQ
  entries expose it via `entry.job.stacktrace`, and fetched jobs also reflect
  `failedReason` (derived from the persisted timeline).
- HTTP `POST /jobs/:id/fail` accepts the same optional `stack` array.
- Defensive caps along the wire: client sends at most 50 lines, server accepts
  at most 100, the job's own `stackTraceLimit` is authoritative.
- The worker `failed` event behavior is unchanged (and now covered by
  regression tests replicating the exact reporter scenario: TCP + auth +
  cron scheduler + preventOverlap/skipIfNoWorker).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.10](/blog/bunqueue-v2-8-10/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.11) · [Commits since v2.8.10](https://github.com/egeominotti/bunqueue/compare/v2.8.10...v2.8.11) · [Full changelog](/changelog/) · [All posts](/blog/)
