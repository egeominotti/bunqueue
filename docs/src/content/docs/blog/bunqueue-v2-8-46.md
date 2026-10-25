---
title: "bunqueue v2.8.46"
description: "Fixes 1 bug. Startup banner regression coverage now validates the runtime shard count against bunqueue's hardware-derived value instead of assuming the 16 shards used by the development machine."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-46.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-22"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.46</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Startup banner regression coverage now validates the runtime shard count against bunqueue's hardware-derived value instead of assuming the 16 shards used by the development machine.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.46

```bash title="bun"
bun add bunqueue@2.8.46
```

```bash title="npm"
npm install bunqueue@2.8.46
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- Startup banner regression coverage now validates the runtime shard count
  against bunqueue's hardware-derived value instead of assuming the 16 shards
  used by the development machine. CI runners with fewer logical CPUs no
  longer reject an otherwise correct banner.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.45](/blog/bunqueue-v2-8-45/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.46) · [Commits since v2.8.44](https://github.com/egeominotti/bunqueue/compare/v2.8.44...v2.8.46) · [Full changelog](/changelog/) · [All posts](/blog/)
