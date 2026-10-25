---
title: "bunqueue v2.8.53"
description: "Fixes 2 bugs. The TCP protocol audit now asks the kernel to bind an available port and reads the assigned listener port before connecting, eliminating the EADDRINUSE race that failed the parallel CI unit gate."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-53.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-31"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.53</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. The TCP protocol audit now asks the kernel to bind an available port and reads the assigned listener port before connecting, eliminating the EADDRINUSE race that failed the parallel CI unit gate.</p>
</div>

#### To install bunqueue v2.8.53

```bash title="bun"
bun add bunqueue@2.8.53
```

```bash title="npm"
npm install bunqueue@2.8.53
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- The TCP protocol audit now asks the kernel to bind an available port and
  reads the assigned listener port before connecting, eliminating the
  `EADDRINUSE` race that failed the parallel CI unit gate.
- A focused regression now rejects pseudo-random high-port selection in this
  real TCP audit and requires the atomic `port: 0` listener contract.

---

[← bunqueue v2.8.52](/blog/bunqueue-v2-8-52/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.53) · [Commits since v2.8.50](https://github.com/egeominotti/bunqueue/compare/v2.8.50...v2.8.53) · [Full changelog](/changelog/) · [All posts](/blog/)
