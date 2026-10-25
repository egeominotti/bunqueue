---
title: "bunqueue v2.7.18"
description: "Fixes 5 bugs. getJobsAsync() (and getWaitingAsync/getDelayedAsync/getActiveAsync/getCompletedAsync/getFailedAsync) dropped job.opts over TCP: listed jobs returned opts: {}, so job.opts.attempts/timeout/etc."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-18.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-05-31"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.18</em></h1>
  <p class="bq-hero-sub">Fixes 5 bugs. getJobsAsync() (and getWaitingAsync/getDelayedAsync/getActiveAsync/getCompletedAsync/getFailedAsync) dropped job.opts over TCP: listed jobs returned opts: {}, so job.opts.attempts/timeout/etc.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.18

```bash title="bun"
bun add bunqueue@2.7.18
```

```bash title="npm"
npm install bunqueue@2.7.18
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- **`JobOptions.removeOnComplete`/`removeOnFail` narrowed to `boolean`**: the previously documented `number | KeepJobs` (age/count retention) forms were never implemented and were silently coerced inconsistently (embedded kept the job, TCP removed it immediately for the same input). The type now rejects the unsupported forms at compile time, the single-`PUSH` path coerces for embedded/TCP parity, and the server hardens `parseCoreOptions` with `Boolean()`. (Worker-level `removeOnComplete`/`removeOnFail` defaults are unaffected.)

## Bugfixes

- **`getJobsAsync()` (and `getWaitingAsync`/`getDelayedAsync`/`getActiveAsync`/`getCompletedAsync`/`getFailedAsync`) dropped `job.opts` over TCP**: listed jobs returned `opts: {}`, so `job.opts.attempts`/`timeout`/etc. were `undefined`, while `getJob(id).opts` was correct. The server already sends the full job; the client now reflects the complete `opts` via `metaFromJob`. This closes the slim-`opts` limitation noted in 2.7.17.
- **Returned Job hardcoded `deduplicationId`/`parentKey`/`parent`/`repeatJobKey`**: `createJobProxy`/`createSimpleJob` set these to `undefined` even when known at call time, diverging from embedded mode. They are now derived from the requested options (shared `reflectFields`), matching `buildJobProperties`.
- **`FlowProducer` silently dropped extended job options**: flow nodes ignored `lifo`, `deduplication`, `durable`, `stallTimeout`, `stackTraceLimit`, `keepLogs`, `sizeLimit`, `repeat`, `timestamp` and `debounce` in **both** embedded and TCP modes (`durable: true` being ignored meant a critical flow job used buffered writes instead of immediate persistence). `flowPush` now forwards the full option set, mirroring `Queue.add`.
- **`job.toJSON()`/`asJSON()` hardcoded `opts: {}` and `delay: 0`**: the BullMQ-compatible serializers on a TCP/bulk-created Job lost the reflected options. They now reflect `opts`, `delay` and `parentKey`.
- **`changePriority({ priority, lifo })` silently dropped `lifo`**: the option was accepted by the type but never applied (the engine had no way to honor it). `lifo` is now threaded end-to-end: `ChangePriorityCommand` → server handler → `queueManager.changePriority` → `jobManagement.changeJobPriority` → `priorityQueue.updatePriority` (updates the tie-break flag). Forwarded from all SDK surfaces: `Queue`, the job proxies, the in-processor job handler, and `FlowProducer` job nodes.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.17](/blog/bunqueue-v2-7-17/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.18) · [Commits since v2.7.17](https://github.com/egeominotti/bunqueue/compare/v2.7.17...v2.7.18) · [Full changelog](/changelog/) · [All posts](/blog/)
