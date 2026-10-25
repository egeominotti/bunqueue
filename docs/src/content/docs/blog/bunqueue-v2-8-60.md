---
title: "bunqueue v2.8.60"
description: "Fixes 1 bug. Fixed workflow generation races exposed by Bun 1.4."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-60.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-08-22"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.60</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Fixed workflow generation races exposed by Bun 1.4.</p>
</div>

#### To install bunqueue v2.8.60

```bash title="bun"
bun add bunqueue@2.8.60
```

```bash title="npm"
npm install bunqueue@2.8.60
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- Raised the Bun runtime floor to 1.4.0. CI, release builds, the production and
  validation images, SDK workflows, local Compose development, and Bun type
  definitions now use Bun 1.4.0 consistently.
- Replaced Biome with pinned Oxlint and Oxfmt tooling in the root project and
  TypeScript SDK, including type-aware linting, CI, pre-commit hooks, isolated
  validation images, suppression directives, and contributor documentation.

## Bugfixes

- Fixed workflow generation races exposed by Bun 1.4. After `close(true)`, the
  old Engine can no longer persist, enqueue, emit, or start user code from a
  late retry, map, loop, decision, child poll, wait, lifecycle call or recovery
  continuation. Graceful close still drains, and already-started forward and
  compensation handlers retain their documented at-least-once semantics.

---

[← bunqueue v2.8.59](/blog/bunqueue-v2-8-59/) · [Full changelog](/changelog/) · [All posts](/blog/)
