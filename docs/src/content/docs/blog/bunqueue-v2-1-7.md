---
title: "bunqueue v2.1.7"
description: "Fixes 2 bugs. 2,664 new tests across 37 files."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-1-7.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-05"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.1.7</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. 2,664 new tests across 37 files.</p>
</div>

#### To install bunqueue v2.1.7

```bash title="bun"
bun add bunqueue@2.1.7
```

```bash title="npm"
npm install bunqueue@2.1.7
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## 2,664 new tests across 37 files

Comprehensive test coverage increase from 1,083 to 3,747 tests (+246%) with zero failures. Coverage spans core operations, data structures, managers, client TCP layer, server handlers, domain types, MCP handlers, and more.

## Bugfixes

- **WriteBuffer silent data loss during shutdown** - `WriteBuffer.stop()` swallowed flush errors and silently dropped buffered jobs. Added `reportLostJobs()` to notify via `onCriticalError` callback when jobs cannot be persisted during shutdown.
- **Queue name consistency in TCP tests** - Fixed port hardcoding in queue-name-consistency test.

---

[← bunqueue v2.1.6](/blog/bunqueue-v2-1-6/) · [Full changelog](/changelog/) · [All posts](/blog/)
