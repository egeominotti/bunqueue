---
title: "bunqueue v2.6.5"
description: "Fixes 2 bugs. Typed event overloads for 'log' event on SandboxedWorker (on/once)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-5.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-06"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.5</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Typed event overloads for 'log' event on SandboxedWorker (on/once).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.5

```bash title="bun"
bun add bunqueue@2.6.5
```

```bash title="npm"
npm install bunqueue@2.6.5
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- Typed event overloads for `'log'` event on SandboxedWorker (`on`/`once`)
- Regression tests for both issues (`test/issue29-sandboxed-log.test.ts`, `test/issue30-dlq-stall.test.ts`)

## Bugfixes

- **SandboxedWorker `log` event not emitted**: The processor's `job.log()` method stored logs via `addLog()` but the SandboxedWorker never emitted a `'log'` event. Listeners registered with `.on('log', ...)` were never called. Now properly emits `(job, message)` on each log call. ([#29](https://github.com/egeominotti/bunqueue/issues/29))
- **SandboxedWorker embedded heartbeats missing**: In embedded mode, `sendHeartbeat` was a no-op and `heartbeatInterval` defaulted to 0 (timer never started). Long-running jobs without `progress()` calls were detected as stalled and moved to DLQ despite still running. Now `sendHeartbeat` calls `manager.jobHeartbeat()` and defaults to 5000ms. ([#30](https://github.com/egeominotti/bunqueue/issues/30))

## Documentation

- Updated SandboxedWorker processor example with `log()`, `fail()`, and `parentId` fields
- Fixed `heartbeatInterval` default from `0` to `5000` in embedded mode docs
- Added `log` event to SandboxedWorker Event Reference (8 events total)
- Added SandboxedWorker section to Stall Detection guide
- Updated SandboxedWorkerOptions type with `heartbeatInterval` and `connection` fields

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.4](/blog/bunqueue-v2-6-4/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.5) · [Commits since v2.6.4](https://github.com/egeominotti/bunqueue/compare/v2.6.4...v2.6.5) · [Full changelog](/changelog/) · [All posts](/blog/)
