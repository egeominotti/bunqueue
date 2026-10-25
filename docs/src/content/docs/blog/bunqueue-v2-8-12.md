---
title: "bunqueue v2.8.12"
description: "Fixes 2 bugs. Re-check the gate before starting."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-12.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-15"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.12</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Re-check the gate before starting.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.12

```bash title="bun"
bun add bunqueue@2.8.12
```

```bash title="npm"
npm install bunqueue@2.8.12
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

The concurrency gate lived only in `poll()` (`activeJobs >= concurrency`), but the
counter is incremented later in `startJob()`, with `await doPullBatch()` (a TCP
round-trip) in between. Nothing serialized concurrent `tryProcess()` runs, so a burst
of fast-completing jobs (e.g. a DLQ retry that finds nothing to do) could fire several
`finally → poll → tryProcess` calls that all passed the gate while `activeJobs` was
still low, all suspended at the pull await, and each then called `startJob()`, driving
`activeJobs` past the configured limit. A second path made it worse: `startJob()`
schedules `tryProcess()` via `setImmediate`, which bypasses `poll()`'s gate entirely.
Reported over TCP with a slow network: up to 10 jobs in flight against a `concurrency`
of 3.

- **Re-check the gate before starting.** `tryProcess()` now re-tests
  `activeJobs >= concurrency` immediately before `startJob()`. There is no `await`
  between the check and `startJob()`'s `activeJobs++`, so the check is atomic with the
  increment and cannot overshoot. This single guard closes both the pull-await path and
  the `setImmediate` bypass.
- **No job loss.** When the gate is closed the already-pulled job is requeued to the
  front of the worker's local buffer (it stays owned via the pull lock) and is started
  as soon as a slot frees.

Reproduced with a deterministic test that models the slow pull
(`test/issue96-concurrency-race.test.ts`): observed concurrency now stays at the limit
(was 4 with `concurrency: 3`).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.11](/blog/bunqueue-v2-8-11/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.12) · [Commits since v2.8.11](https://github.com/egeominotti/bunqueue/compare/v2.8.11...v2.8.12) · [Full changelog](/changelog/) · [All posts](/blog/)
