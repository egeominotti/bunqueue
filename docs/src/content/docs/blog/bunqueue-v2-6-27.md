---
title: "bunqueue v2.6.27"
description: "Fixes 2 bugs. WebSocket/SSE integration tests."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-27.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-15"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.27</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. WebSocket/SSE integration tests.</p>
</div>

#### To install bunqueue v2.6.27

```bash title="bun"
bun add bunqueue@2.6.27
```

```bash title="npm"
npm install bunqueue@2.6.27
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## WebSocket/SSE integration tests

88 new integration tests covering WebSocket and SSE event streaming.

## Bugfixes

- **`getJob` returns null for failed/DLQ jobs**: In embedded mode (no SQLite storage), `getJob()` and `getJobByCustomId()` now correctly query the shard DLQ instead of returning null. (#50)
- **`getChildrenValues` wired in worker**: Worker job processor now correctly passes the `getChildrenValues` callback.

---

[← bunqueue v2.6.26](/blog/bunqueue-v2-6-26/) · [Full changelog](/changelog/) · [All posts](/blog/)
