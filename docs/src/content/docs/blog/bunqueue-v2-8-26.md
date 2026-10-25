---
title: "bunqueue v2.8.26"
description: "A correctness release from an exhaustive feature + extreme-stress audit (every subsystem, embedded and TCP)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-26.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-01"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.26</em></h1>
  <p class="bq-hero-sub">A correctness release from an exhaustive feature + extreme-stress audit (every subsystem, embedded and TCP).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

A correctness release from an exhaustive feature + extreme-stress audit (every subsystem, embedded **and** TCP). Seven fixes; all pre-existing, none data-loss in normal operation, each shipped with a RED→GREEN reproduction test.

#### To install bunqueue v2.8.26

```bash title="bun"
bun add bunqueue@2.8.26
```

```bash title="npm"
npm install bunqueue@2.8.26
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Security

`http://[::ffff:127.0.0.1]/…`, the deprecated IPv4-compatible `[::127.0.0.1]`, and IPv6 ULA (`fc00::/7`) / link-local (`fe80::/10`) / unspecified (`::`) hosts bypassed the webhook SSRF check (in both dotted and WHATWG hex-normalized forms). The validator now unwraps mapped/compatible addresses and blocks the IPv6 private ranges before delivery.

## Bugfixes

Re-adding a job with an existing `jobId` while the prior job was **active** (being processed) or **waiting-children** threw `UNIQUE constraint failed: jobs.id` for durable jobs, or silently dropped the colliding insert (leaving an in-memory duplicate) for buffered jobs, instead of the documented idempotent no-op. `handleCustomId` only handled the still-queued case; it now idempotent-skips for every unfinished state, gated so a **completed** id still recycles into a fresh job (#92). The customId twin of the uniqueKey fix #69.

## Bugfixes

A durable `jobs` row could outlive its in-memory tracking when `obliterate()` (fire-and-forget over TCP) or a write-buffer flush raced an in-flight insert, or when a completed customId job aged out of the 50k `completedJobs` window. Re-adding the same id then hit `UNIQUE constraint failed: jobs.id`. Both insert statements now use `INSERT … ON CONFLICT(id) DO UPDATE` (upsert): a brand-new id is a plain INSERT (zero hot-path cost), an orphan is overwritten in place. The `DO UPDATE SET` resets **all** non-id columns, including `started_at`/`completed_at`/`progress`/`progress_msg`/`last_heartbeat`/`stacktrace`, so a recycled id never inherits a prior life's `progress=100` or stale stacktrace. In the buffered batch path this also stops one stale collision from failing the whole flush and dropping every innocent job batched in the same window.

## Bugfixes

Two concurrent/duplicate signals (or a signal arriving before the run parked) re-enqueued the current node, so every step after the `waitFor` (e.g. a side-effecting `charge`) ran twice, an exactly-once violation. `signal()` now records the payload always but only resumes a genuinely-parked run (`state === 'waiting'`), flipping to `running` synchronously so duplicate signals collapse to a single resume.

## Bugfixes

`Queue.moveJobToDelayed(id, timestamp)` / `job.moveToDelayed(timestamp)` over TCP left a waiting job waiting (no-op) and dropped the delay on an active job (re-queued as `waiting`). The client sent `{ timestamp }` but the command/handler read `delay` (→ `runAt = now + undefined = NaN`), and the server op only handled active jobs. The client now sends the relative `delay`, and `moveToDelayed` routes through `changeDelay` (handles in-queue + active). The new `run_at` is now **persisted** (`storage.updateRunAt`), so the delay survives a restart, previously `moveToDelayed`/`changeDelay` mutated only the in-memory heap and the delay was lost on recovery. Embedded was unaffected by the no-op bug.

## Bugfixes

With the documented API `add(name, data, { deduplication: { id, replace: true } })` (no explicit `jobId`), embedded set `customId = deduplication.id`, so `handleCustomId` short-circuited the re-add before the replace/extend strategy ran, the original job survived. The dedup id now rides only on `uniqueKey` (matching TCP); `customId` is set from an explicit `jobId` only. `deduplicationId` on the returned job is sourced from `customId ?? uniqueKey` so it still reflects the requested id (#90).

## Bugfixes

The TCP client read `response.stats.completed` / `.dlq`, but the `Metrics` handler returns `response.metrics.totalCompleted` / `.totalFailed`. The client now reads the correct fields.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.25](/blog/bunqueue-v2-8-25/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.26) · [Commits since v2.8.25](https://github.com/egeominotti/bunqueue/compare/v2.8.25...v2.8.26) · [Full changelog](/changelog/) · [All posts](/blog/)
