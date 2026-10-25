---
title: "bunqueue v2.3.1"
description: "Fixes 2 bugs. Non-numeric job IDs - Allow non-numeric job IDs in HTTP routes"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-3-1.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-02-08"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.3.1</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Non-numeric job IDs - Allow non-numeric job IDs in HTTP routes</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.3.1

```bash title="bun"
bun add bunqueue@2.3.1
```

```bash title="npm"
npm install bunqueue@2.3.1
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Non-numeric job IDs** - Allow non-numeric job IDs in HTTP routes
- Updated HTTP route tests to match non-numeric job ID support

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.3.0](/blog/bunqueue-v2-3-0/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.3.1) · [Commits since v2.3.0](https://github.com/egeominotti/bunqueue/compare/v2.3.0...v2.3.1) · [Full changelog](/changelog/) · [All posts](/blog/)
