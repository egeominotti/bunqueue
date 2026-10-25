---
title: "bunqueue v2.7.5"
description: "Fixes 1 bug. job.moveToFailed() inside processor was a no-op (Issue #82), Calling job.moveToFailed() inside a worker processor silently did nothing because move method callbacks were not wired to createPublicJob."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-5.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-16"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.5</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. job.moveToFailed() inside processor was a no-op (Issue #82), Calling job.moveToFailed() inside a worker processor silently did nothing because move method callbacks were not wired to createPublicJob.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.5

```bash title="bun"
bun add bunqueue@2.7.5
```

```bash title="npm"
npm install bunqueue@2.7.5
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- Extracted handler factories from `processor.ts` into new `src/client/worker/processorHandlers.ts` for single-responsibility compliance.

## Bugfixes

- **`job.moveToFailed()` inside processor was a no-op** (Issue #82), Calling `job.moveToFailed()` inside a worker processor silently did nothing because move method callbacks were not wired to `createPublicJob`. The worker then auto-ACKed the job, marking it as completed instead of failed. Now `moveToFailed()` and `moveToCompleted()` work correctly inside processors: they send the appropriate command and prevent the auto-ACK from overriding the state.

## Tests

- 3 new issue #82 reproduction tests (`test/issue-82-moveToFailed.test.ts`)

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.4](/blog/bunqueue-v2-7-4/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.5) · [Commits since v2.7.4](https://github.com/egeominotti/bunqueue/compare/v2.7.4...v2.7.5) · [Full changelog](/changelog/) · [All posts](/blog/)
