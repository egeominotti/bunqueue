---
title: "bunqueue v2.8.29"
description: "Fixes 3 bugs. retryJobs({ state:'failed', count }) ignored count: the client sent it (or, in the SDKs, explicitly dropped it) but the RetryDlq command/handler had no count field, so the entire DLQ was retried instead of the requested N."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-29.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-09"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.29</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. retryJobs({ state:'failed', count }) ignored count: the client sent it (or, in the SDKs, explicitly dropped it) but the RetryDlq command/handler had no count field, so the entire DLQ was retried instead of the requested N.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.29

```bash title="bun"
bun add bunqueue@2.8.29
```

```bash title="npm"
npm install bunqueue@2.8.29
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

`queue.upsertJobScheduler(id, { every, limit }, template)` accepted a `limit` in `RepeatOpts` but the client scheduler never mapped it to the cron engine's `maxLimit`, so the run cap was persisted as `NULL` and the scheduler fired forever. The whole backend already supported it (`CronJobInput.maxLimit`, `hasReachedLimit`, the `Cron` command, the handler), only the client builder omitted it. Fixed on **both** the embedded and TCP paths; `limit` is now surfaced back on `SchedulerInfo.limit` (via `getJobScheduler`/`getJobSchedulers`), the simple-mode `Bunqueue.cron()/every()` helpers gained a `limit` option, and the reporter's third request, exposing it on the return type, is honoured. RED→GREEN reproduction tests cover embedded and TCP.

## Bugfixes

Auditing #111 surfaced three siblings of the same class, all fixed with reproduction tests:

- **`retryJobs({ state:'failed', count })` ignored `count`**: the client sent it (or, in the SDKs, explicitly dropped it) but the `RetryDlq` command/handler had no `count` field, so the **entire** DLQ was retried instead of the requested N. Added `count` end-to-end (wire → handler → `retryDlq(queue, jobId?, limit?)` → a bounded `retryDlqJobs` that reuses the tested per-entry `retryDlqJob`, leaving the remainder in the DLQ). The Python and TypeScript SDKs now forward `count` too (forward-compatible: older servers ignore it).
- **`Queue.moveJobToFailed()` dropped the stacktrace and `UnrecoverableError`**: the Queue reflection API and the job proxies sent only `{ error: message }`, losing the stack (#74 sibling) and treating an `UnrecoverableError` as a normal retryable failure. All four client failure sites (`jobMove`, two job proxies, the flow job proxy, the sandboxed worker) now route through a shared `failWire` helper that mirrors the worker path (`stack` + `unrecoverable`).
- **`Worker.getNextJob()` ignored `lockDuration`**: the manual-acquire API used the server-default lock TTL on both the embedded and TCP paths, silently discarding a custom `lockDuration` (the main run-loop path already forwarded it).

The polyglot SDKs were already correct on `limit`→`maxLimit`; only the count drop needed fixing there.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.28](/blog/bunqueue-v2-8-28/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.29) · [Commits since v2.8.28](https://github.com/egeominotti/bunqueue/compare/v2.8.28...v2.8.29) · [Full changelog](/changelog/) · [All posts](/blog/)
