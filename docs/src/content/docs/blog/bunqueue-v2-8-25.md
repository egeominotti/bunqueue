---
title: "bunqueue v2.8.25"
description: "Fixes 3 bugs. Fixed in src/client/queue/operations/query.ts for all three affected sites: getJobs (embedded), getJobsAsync (TCP), and getJob(id) over TCP, the last was the inverse of the same gap (its TCP branch patched only progress, so…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-25.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-29"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.25</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. Fixed in src/client/queue/operations/query.ts for all three affected sites: getJobs (embedded), getJobsAsync (TCP), and getJob(id) over TCP, the last was the inverse of the same gap (its TCP branch patched only progress, so…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.25

```bash title="bun"
bun add bunqueue@2.8.25
```

```bash title="npm"
npm install bunqueue@2.8.25
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

`queue.getJobs()`, `getJobsAsync()`, and the `getCompleted()`/`getFailed()`/`getWaiting()`/`getDelayed()`/`getActive()` wrappers that delegate to them returned public job objects whose `finishedOn` and `processedOn` were always `undefined`, even for completed jobs, while the **same** job fetched via `getJob(id)` returned them correctly. Root cause: the list paths build jobs via `createSimpleJob`, which hardcodes `finishedOn: undefined`/`processedOn: undefined`, and never patched them from the internal job's `completedAt`/`startedAt` (unlike `progress`/`priority`/`attemptsMade`). `getJob(id)` worked only because it routes through `toPublicJob` → `buildJobProperties`.

- Fixed in `src/client/queue/operations/query.ts` for **all three** affected sites: `getJobs` (embedded), `getJobsAsync` (TCP), **and** `getJob(id)` over TCP, the last was the inverse of the same gap (its TCP branch patched only `progress`, so post-fix it would have disagreed with `getJobs`). All now mirror `buildJobProperties`: a numeric timestamp maps through, `null` → `undefined` (guarded by `typeof === 'number'`).
- The failure path is intentionally untouched: a failed job has no `completedAt` (only the success path sets it; `completedAt` doubles as a "completed" signal in cloud state classification and `waitUntilFinished`), so `finishedOn` stays `undefined` for failed jobs in **both** `getJob` and `getJobs`, consistent. A failed job's `processedOn` **is** populated (it was started), matching `getJob`.
- Tests: `test/repro-issue104-getjobs-finishedon.test.ts` (6 embedded cases incl. parity with `getJob`, a populated failed-job `processedOn`, and a negative still-waiting case) and a new TCP integration case in `scripts/tcp/test-query-operations.ts` ("finishedOn/processedOn over TCP") exercising the real wire path for both `getJobsAsync` and `getJob(id)`.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.24](/blog/bunqueue-v2-8-24/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.25) · [Commits since v2.8.24](https://github.com/egeominotti/bunqueue/compare/v2.8.24...v2.8.25) · [Full changelog](/changelog/) · [All posts](/blog/)
