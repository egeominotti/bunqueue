---
title: "bunqueue v2.8.43"
description: "Fixes 2 bugs. TypeScript SDK E2E fixtures now let the operating system allocate each broker's unused HTTP port independently."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-43.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-19"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.43</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. TypeScript SDK E2E fixtures now let the operating system allocate each broker's unused HTTP port independently.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.43

```bash title="bun"
bun add bunqueue@2.8.43
```

```bash title="npm"
npm install bunqueue@2.8.43
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- TypeScript SDK E2E fixtures now let the operating system allocate each
  broker's unused HTTP port independently. Starting the dedicated auth broker
  can no longer collide with the primary fixture's TCP port and wait 15
  seconds before failing.
- Regression coverage keeps the general, crash/restart and Cloudflare Workers
  harnesses on the collision-free port strategy.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.42](/blog/bunqueue-v2-8-42/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.43) · [Commits since v2.8.42](https://github.com/egeominotti/bunqueue/compare/v2.8.42...v2.8.43) · [Full changelog](/changelog/) · [All posts](/blog/)
