---
title: "bunqueue v2.6.96"
description: "Fixes 1 bug. Job state race condition in TCP mode: getJobState() inside the completed event callback now correctly returns completed instead of active (fixes #72)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-96.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-01"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.96</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Job state race condition in TCP mode: getJobState() inside the completed event callback now correctly returns completed instead of active (fixes #72).</p>
</div>

#### To install bunqueue v2.6.96

```bash title="bun"
bun add bunqueue@2.6.96
```

```bash title="npm"
npm install bunqueue@2.6.96
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Job state race condition in TCP mode**: `getJobState()` inside the `completed` event callback now correctly returns `completed` instead of `active` (fixes #72). Root cause: ACK was fire-and-forget (`void`), so the event was emitted before the server processed the acknowledgment.

---

[← bunqueue v2.6.95](/blog/bunqueue-v2-6-95/) · [Full changelog](/changelog/) · [All posts](/blog/)
