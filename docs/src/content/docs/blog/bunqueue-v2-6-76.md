---
title: "bunqueue v2.6.76"
description: "Ships 2 additions. Integration test scripts for monitoring, query operations, cron event-driven scheduling, and sandboxed workers (TCP + embedded modes)"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-76.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-24"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.76</em></h1>
  <p class="bq-hero-sub">Ships 2 additions. Integration test scripts for monitoring, query operations, cron event-driven scheduling, and sandboxed workers (TCP + embedded modes)</p>
</div>

#### To install bunqueue v2.6.76

```bash title="bun"
bun add bunqueue@2.6.76
```

```bash title="npm"
npm install bunqueue@2.6.76
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

- Integration test scripts for monitoring, query operations, cron event-driven scheduling, and sandboxed workers (TCP + embedded modes)
- Unit tests for issues #29 (sandboxed worker `log` method), #38 (sandboxed processor cleanup), #41 (sandboxed idle RAM)

---

[← bunqueue v2.6.75](/blog/bunqueue-v2-6-75/) · [Full changelog](/changelog/) · [All posts](/blog/)
