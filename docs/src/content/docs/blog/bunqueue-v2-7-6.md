---
title: "bunqueue v2.7.6"
description: "Fixes 7 bugs. Systemic silent no-op in ~20 job methods (Issue #82 follow-up), Across 6 factories (processor.ts, jobProxy.ts, flowJobFactory.ts, jobConversion.ts, sandboxed worker, flow), many job methods (retry, moveToWait…"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-6.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-17"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.6</em></h1>
  <p class="bq-hero-sub">Fixes 7 bugs. Systemic silent no-op in ~20 job methods (Issue #82 follow-up), Across 6 factories (processor.ts, jobProxy.ts, flowJobFactory.ts, jobConversion.ts, sandboxed worker, flow), many job methods (retry, moveToWait…</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.6

```bash title="bun"
bun add bunqueue@2.7.6
```

```bash title="npm"
npm install bunqueue@2.7.6
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Systemic silent no-op in ~20 job methods** (Issue #82 follow-up), Across 6 factories (`processor.ts`, `jobProxy.ts`, `flowJobFactory.ts`, `jobConversion.ts`, `sandboxed worker`, flow), many job methods (`retry`, `moveToWait`, `updateProgress`, `log`, `remove`, etc.) were hardcoded to no-op or silently returned stale values in TCP mode. Same class of silent corruption as the original #82 report. All wired to real handlers with explicit errors on unsupported transitions.
- **`job.retry()` BullMQ contract**: Previously always routed to `retryDlq`, which silently no-op'd when the job was not in DLQ (e.g. `removeOnFail: true`, or retry attempted before DLQ persistence). Now state-dispatched: `failed→retryDlq` (throws if 0), `active→moveActiveToWait`, `waiting/prioritized/delayed→no-op`, other→throw.
- **`moveToWait` semantic divergence between embedded and TCP**: Embedded called `moveActiveToWait` (active→waiting) while the TCP server handler called `promote()` (delayed→waiting). Same API, opposite outcomes. Server handler now state-dispatches to match embedded; `jobProxy` embedded path also state-dispatches.
- **`Queue.obliterate()` leaked active jobs + completed state + SQLite rows**: Only shard state was cleared; `jobIndex` (processing variant), `processingShards`, `completedJobs`, `completedJobsData`, `jobResults`, `jobLogs`, `jobLocks`, `repeatChain`, `customIdMap`, DLQ, and persistence tables all survived. Pagination reported wrong counts, memory leaked, obliterated jobs could re-materialize after restart. Now fully purged.
- **Sandboxed worker `ModuleNotFound` on concurrent spawn** (macOS), Two root causes: (1) `$TMPDIR` trailing slash produced `//` in wrapper path; (2) concurrent `new Worker()` raced for Bun's bundler cache. Fixed by (1) `path.join` normalization + `fsync` on write + existence poll that throws on miss, and (2) serializing the first worker spawn so the bundle is cached before siblings load.
- **`res.ok` truthy read on `unknown`**: 4 sites (`extendLock` handlers, `moveToWait`) used loose `res.ok ? x : y`; harmonized to `=== true`.
- **`jobProxy.extendLock` dropped the user-provided token in TCP mode**: Server saw `null` and could reject or no-op depending on `jobLocks` ownership. Token now passed through.

## Tests

- New `test/obliterate-clears-completed.test.ts` (3 tests: post-complete, pagination, active-job purge).
- New `test/retry-contract.test.ts` (2 tests: BullMQ contract on DLQ and non-DLQ failed jobs).
- New `test/movetowait-semantics.test.ts` (3 tests: delayed, active, waiting idempotence).
- New `test/audit-unwired-processor-methods.test.ts` + `test/wired-job-methods-embedded.test.ts` proving every previously-unwired method is now reachable.
- Post-condition assertions added for `remove()` inside processor.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.5](/blog/bunqueue-v2-7-5/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.6) · [Commits since v2.7.5](https://github.com/egeominotti/bunqueue/compare/v2.7.5...v2.7.6) · [Full changelog](/changelog/) · [All posts](/blog/)
