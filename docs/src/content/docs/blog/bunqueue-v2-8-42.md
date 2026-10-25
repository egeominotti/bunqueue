---
title: "bunqueue v2.8.42"
description: "Fixes 3 bugs. Weekly SDK soaks now raise the disposable broker's protocol request budget, so long-lived single-connection profiles measure SDK health instead of stopping at the production anti-abuse limit after roughly one minute."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-42.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.42</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. Weekly SDK soaks now raise the disposable broker's protocol request budget, so long-lived single-connection profiles measure SDK health instead of stopping at the production anti-abuse limit after roughly one minute.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.42

```bash title="bun"
bun add bunqueue@2.8.42
```

```bash title="npm"
npm install bunqueue@2.8.42
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- Weekly SDK soaks now raise the disposable broker's protocol request budget,
  so long-lived single-connection profiles measure SDK health instead of
  stopping at the production anti-abuse limit after roughly one minute.
- The Elixir soak now follows the SDK's public unit-operation contract:
  `Queue.obliterate/1` returns `:ok`.
- Weekly dependency advisories run in a dedicated workflow, preserving the
  same schedule while keeping CI definitions within the 300-line limit.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.41](/blog/bunqueue-v2-8-41/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.42) · [Commits since v2.8.41](https://github.com/egeominotti/bunqueue/compare/v2.8.41...v2.8.42) · [Full changelog](/changelog/) · [All posts](/blog/)
