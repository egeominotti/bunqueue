---
title: "bunqueue v1.6.8"
description: "Fixes 2 bugs. Renamed bunq to bunqueue in Dockerfile"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v1-6-8.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-01-27"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v1.6.8</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Renamed bunq to bunqueue in Dockerfile</p>
</div>

#### To install bunqueue v1.6.8

```bash title="bun"
bun add bunqueue@1.6.8
```

```bash title="npm"
npm install bunqueue@1.6.8
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- Centralized version in `shared/version.ts`

## Bugfixes

- Renamed bunq to bunqueue in Dockerfile
- CLI version now read dynamically from package.json

---

[← bunqueue v1.6.7](/blog/bunqueue-v1-6-7/) · [Full changelog](/changelog/) · [All posts](/blog/)
