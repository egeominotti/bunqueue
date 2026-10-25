---
title: "bunqueue v1.9.6"
description: "Durable Writes."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v1-9-6.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-01-31"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v1.9.6</em></h1>
  <p class="bq-hero-sub">Durable Writes.</p>
</div>

#### To install bunqueue v1.9.6

```bash title="bun"
bun add bunqueue@1.9.6
```

```bash title="npm"
npm install bunqueue@1.9.6
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Durable Writes

New `durable: true` option for critical jobs
- Bypasses write buffer for immediate disk persistence
- Guarantees no data loss on process crash
- Use for payments, orders, and critical events

## Changes

- **Reduced write buffer flush interval** from 50ms to 10ms
  - Smaller data loss window for non-durable jobs
  - Better balance between throughput and safety

---

[← bunqueue v1.9.4](/blog/bunqueue-v1-9-4/) · [Full changelog](/changelog/) · [All posts](/blog/)
