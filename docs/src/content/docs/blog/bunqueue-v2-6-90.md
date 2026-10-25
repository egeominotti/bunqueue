---
title: "bunqueue v2.6.90"
description: "Simple Mode (Bunqueue class), documentation."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-90.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-31"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.90</em></h1>
  <p class="bq-hero-sub">Simple Mode (Bunqueue class), documentation.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.90

```bash title="bun"
bun add bunqueue@2.6.90
```

```bash title="npm"
npm install bunqueue@2.6.90
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Simple Mode (`Bunqueue` class)

New unified API that combines Queue + Worker into a single object. Includes route-based job dispatching, onion-model middleware chain, and simplified cron scheduling via `cron()` and `every()`. Works in both embedded and TCP modes. Import as `import { Bunqueue } from 'bunqueue/client'`.

## Documentation

Comprehensive Simple Mode guide at `/guide/simple-mode/`, README section, and CLAUDE.md reference.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.89](/blog/bunqueue-v2-6-89/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.90) · [Commits since v2.6.89](https://github.com/egeominotti/bunqueue/compare/v2.6.89...v2.6.90) · [Full changelog](/changelog/) · [All posts](/blog/)
