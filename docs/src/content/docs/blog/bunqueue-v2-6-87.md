---
title: "bunqueue v2.6.87"
description: "Fixes 1 bug. skipIfNoWorker not working on restart (#67), when a cron job had skipIfNoWorker: true and the server restarted with past-due nextRun, the missed cron fired immediately because workers reconnected before the scheduler tick."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-87.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-30"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.87</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. skipIfNoWorker not working on restart (#67), when a cron job had skipIfNoWorker: true and the server restarted with past-due nextRun, the missed cron fired immediately because workers reconnected before the scheduler tick.</p>
</div>

#### To install bunqueue v2.6.87

```bash title="bun"
bun add bunqueue@2.6.87
```

```bash title="npm"
npm install bunqueue@2.6.87
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **`skipIfNoWorker` not working on restart** ([#67](https://github.com/egeominotti/bunqueue/issues/67)), when a cron job had `skipIfNoWorker: true` and the server restarted with past-due `nextRun`, the missed cron fired immediately because workers reconnected before the scheduler tick. The `load()` method now recalculates `nextRun` to the next future occurrence when `skipIfNoWorker` is enabled, preventing missed cron executions on restart.

---

[← bunqueue v2.6.85](/blog/bunqueue-v2-6-85/) · [Full changelog](/changelog/) · [All posts](/blog/)
