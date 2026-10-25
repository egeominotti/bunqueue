---
title: "bunqueue v2.6.34"
description: "Fixes 1 bug. QueueEvents failed events: failedReason now correctly reads from event.error instead of event.data, job data is included in failed broadcasts, and error emission includes event context."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-34.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-16"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.34</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. QueueEvents failed events: failedReason now correctly reads from event.error instead of event.data, job data is included in failed broadcasts, and error emission includes event context.</p>
</div>

#### To install bunqueue v2.6.34

```bash title="bun"
bun add bunqueue@2.6.34
```

```bash title="npm"
npm install bunqueue@2.6.34
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- **CI**: Disabled TCP and Embedded integration tests in GitHub Actions pipeline
- Removed flaky SandboxedWorker tests

## Bugfixes

- **QueueEvents failed events**: `failedReason` now correctly reads from `event.error` instead of `event.data`, job `data` is included in failed broadcasts, and error emission includes event context. ([#54](https://github.com/egeominotti/bunqueue/pull/54)), thanks @simontong

---

[← bunqueue v2.6.33](/blog/bunqueue-v2-6-33/) · [Full changelog](/changelog/) · [All posts](/blog/)
