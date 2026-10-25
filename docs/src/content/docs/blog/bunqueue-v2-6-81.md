---
title: "bunqueue v2.6.81"
description: "Fixes 1 bug. Worker API enhancements, worker options now fully wired."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-81.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-26"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.81</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Worker API enhancements, worker options now fully wired.</p>
</div>

#### To install bunqueue v2.6.81

```bash title="bun"
bun add bunqueue@2.6.81
```

```bash title="npm"
npm install bunqueue@2.6.81
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Removed

- Cleaned up 7 unimplemented WorkerOptions stubs that were type-only (now all options are wired to actual behavior)

## Worker API enhancements

(BullMQ v5 compatibility):
- `concurrency` getter/setter, change concurrency at runtime without restarting the worker
- `closing` property, Promise that resolves when `close()` finishes
- `off()` typed overloads, remove event listeners with full TypeScript support
- `name` and `opts` are now public readonly properties

## Worker options now fully wired

- `skipLockRenewal`, disables heartbeat timer when `true`
- `skipStalledCheck`, disables stalled event subscription when `true`
- `drainDelay`, configurable delay between polls when queue is drained (default: 50ms, was hardcoded)
- `lockDuration`, stored in opts with default 30000ms
- `maxStalledCount`, stored in opts with default 1
- `removeOnComplete` / `removeOnFail`, worker-level defaults applied to all processed jobs

## Bugfixes

- `drainDelay` default corrected from 5000ms to 50ms in documentation

---

[← bunqueue v2.6.80](/blog/bunqueue-v2-6-80/) · [Full changelog](/changelog/) · [All posts](/blog/)
