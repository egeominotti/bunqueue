---
title: "bunqueue v2.8.3"
description: "bunqueue 2.8.3 release notes."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-3.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-03"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.3</em></h1>
  <p class="bq-hero-sub">bunqueue 2.8.3 release notes.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.3

```bash title="bun"
bun add bunqueue@2.8.3
```

```bash title="npm"
npm install bunqueue@2.8.3
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

With the `exports` map defined, `require('bunqueue/package.json')` (and `import`
of the same subpath) failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Some tools read
a dependency's `package.json` directly (e.g. to detect the installed version).
Added `"./package.json": "./package.json"` to `exports`. No other change; all
existing subpath exports (`.`, `./client`, `./queue`, `./mcp`, `./workflow`) are
unaffected.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.2](/blog/bunqueue-v2-8-2/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.3) · [Commits since v2.8.2](https://github.com/egeominotti/bunqueue/compare/v2.8.2...v2.8.3) · [Full changelog](/changelog/) · [All posts](/blog/)
