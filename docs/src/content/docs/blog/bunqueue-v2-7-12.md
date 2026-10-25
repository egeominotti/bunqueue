---
title: "bunqueue v2.7.12"
description: "Remove 63 unnecessary as Type assertions across src/ flagged by @typescript-eslint/no-unnecessary-type-assertion on CI's stricter @types/bun@1.3.13."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-12.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-05-11"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.12</em></h1>
  <p class="bq-hero-sub">Remove 63 unnecessary as Type assertions across src/ flagged by @typescript-eslint/no-unnecessary-type-assertion on CI's stricter @types/bun@1.3.13.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.12

```bash title="bun"
bun add bunqueue@2.7.12
```

```bash title="npm"
npm install bunqueue@2.7.12
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Internal

- Remove 63 unnecessary `as Type` assertions across `src/` flagged by `@typescript-eslint/no-unnecessary-type-assertion` on CI's stricter `@types/bun@1.3.13`. Pure type-level cleanup, no runtime impact.
- Refactor `src/cli/output.ts` `str()` to narrow `unknown` via explicit `typeof` branches and a `{ toString(): string }` interface cast, avoiding both `no-unnecessary-type-assertion` and `no-base-to-string` rule conflicts.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.11](/blog/bunqueue-v2-7-11/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.12) · [Commits since v2.7.10](https://github.com/egeominotti/bunqueue/compare/v2.7.10...v2.7.12) · [Full changelog](/changelog/) · [All posts](/blog/)
