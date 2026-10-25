---
title: "bunqueue v2.6.105"
description: "Fixes 1 bug. skipIfNoWorker now ignores stale workers: getForQueue() was returning ALL registered workers regardless of heartbeat status."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-105.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-02"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.105</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. skipIfNoWorker now ignores stale workers: getForQueue() was returning ALL registered workers regardless of heartbeat status.</p>
</div>

#### To install bunqueue v2.6.105

```bash title="bun"
bun add bunqueue@2.6.105
```

```bash title="npm"
npm install bunqueue@2.6.105
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **`skipIfNoWorker` now ignores stale workers**: `getForQueue()` was returning ALL registered workers regardless of heartbeat status. When a client disconnected without clean TCP close (e.g., network issues between WSL and remote VPS), the worker remained registered as "stale" for up to 90 seconds. During this window, `skipIfNoWorker` would find the stale worker and push cron jobs. Now only workers with a recent heartbeat (within `WORKER_TIMEOUT_MS`, default 30s) are counted (fixes #73).

---

[← bunqueue v2.6.104](/blog/bunqueue-v2-6-104/) · [Full changelog](/changelog/) · [All posts](/blog/)
