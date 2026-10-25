---
title: "bunqueue v2.8.58"
description: "Fixes 4 bugs. Queue now releases its constructor-owned shared TCP pool reference exactly once, so duplicate close() calls and disconnect() followed by close() cannot break unrelated Queue instances."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-58.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-08-04"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.58</em></h1>
  <p class="bq-hero-sub">Fixes 4 bugs. Queue now releases its constructor-owned shared TCP pool reference exactly once, so duplicate close() calls and disconnect() followed by close() cannot break unrelated Queue instances.</p>
</div>

#### To install bunqueue v2.8.58

```bash title="bun"
bun add bunqueue@2.8.58
```

```bash title="npm"
npm install bunqueue@2.8.58
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Removed

- Removed StrykerJS from the TypeScript SDK — mutation job, config, script,
  dev dependency and the `qs` override it needed. Its dependency graph produced
  every finding the weekly advisory gate reported (`qs` via `typed-rest-client`,
  then `fast-uri` via `ajv`), none of it reachable from the published client.
  The planners keep their fast-check coverage and the other five SDKs still run
  mutation. The dev dependency tree drops from 163 packages to 10 with a clean
  `bun audit`.

## Bugfixes

- Queue now releases its constructor-owned shared TCP pool reference exactly
  once, so duplicate `close()` calls and `disconnect()` followed by `close()`
  cannot break unrelated Queue instances. Worker shutdown is also monotonic:
  stale `run()` or `resume()` callbacks are ignored after `close()` begins and
  cannot process another batch during teardown.
- Made graceful cancellation, priority aging, scheduled S3 backups, and Cloud
  Agent timers lifecycle-safe. Repeated starts/cancels now retain a single
  owned handle, cleanup cannot leave an orphan generation behind, and stale
  queued callbacks cannot resume work after stop. Existing cancellation timing
  remains earliest-deadline-wins; synchronous processor and middleware throws
  also release their exact cancellation generation, including when a user
  circuit-breaker hook throws during outcome notification. In-process retry
  now handles synchronous throws identically to rejected Promises, and
  cancellation or `close()` clears an armed backoff so processing cannot resume
  after shutdown. Circuit-breaker destruction is now terminal, so a retry
  rejected during shutdown cannot rearm its reset timer; explicit cancellation
  keeps its existing cooperative success/failure outcome behavior.
- Fixed [#113](https://github.com/egeominotti/bunqueue/issues/113): Worker poll
  wake-ups are now coalesced into one earliest-deadline timer. A later backoff
  cannot postpone a wake-up that was already due sooner. Completed jobs no
  longer leave self-perpetuating timer chains that make idle CPU grow with the
  processed-job count, and pause/close clear the same timer ownership state.
- Embedded Queue, Worker, and QueueEvents construction now fails synchronously
  when an explicit `dataPath` conflicts with the process-wide QueueManager's
  active database. Paths are canonicalized so equivalent relative, absolute,
  and symlink spellings remain compatible; omitted paths continue to join the
  active manager. This prevents `durable: true` jobs from being accepted into
  memory after an earlier client initialized the singleton without storage.

---

[← bunqueue v2.8.57](/blog/bunqueue-v2-8-57/) · [Full changelog](/changelog/) · [All posts](/blog/)
