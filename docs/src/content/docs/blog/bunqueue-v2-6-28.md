---
title: "bunqueue v2.6.28"
description: "Fixes 1 bug. getChildrenValues empty in TCP mode: Fixed response envelope unwrap in worker processor (response.data.values instead of response.values)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-28.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.28</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. getChildrenValues empty in TCP mode: Fixed response envelope unwrap in worker processor (response.data.values instead of response.values).</p>
</div>

#### To install bunqueue v2.6.28

```bash title="bun"
bun add bunqueue@2.6.28
```

```bash title="npm"
npm install bunqueue@2.6.28
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **`getChildrenValues` empty in TCP mode**: Fixed response envelope unwrap in worker processor (`response.data.values` instead of `response.values`). Fixed `childrenIds`/`parentId` not passed through TCP protocol in flow jobs. (#49, PR by @simontong)

---

[← bunqueue v2.6.27](/blog/bunqueue-v2-6-27/) · [Full changelog](/changelog/) · [All posts](/blog/)
