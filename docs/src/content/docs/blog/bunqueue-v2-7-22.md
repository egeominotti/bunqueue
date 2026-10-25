---
title: "bunqueue v2.7.22"
description: "Fixes 1 bug. Pinned typescript-eslint to exact 8.56.1 (dropped the ^ caret) in package.json so CI no longer floats into a broken or unexpected upstream release."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-22.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-02"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.22</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Pinned typescript-eslint to exact 8.56.1 (dropped the ^ caret) in package.json so CI no longer floats into a broken or unexpected upstream release.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.22

```bash title="bun"
bun add bunqueue@2.7.22
```

```bash title="npm"
npm install bunqueue@2.7.22
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

CI lint job failed with `error: No version matching "8.60.1" found for specifier "@typescript-eslint/types" (but package exists)`. Root cause: `bun.lock` is gitignored and CI runs `bun install` without `--frozen-lockfile`, so every run does a fresh, non-reproducible resolve. The dev dependency was declared `typescript-eslint: "^8.56.1"`, which floated up to `8.60.1`, an upstream release whose meta-package was published before its sub-packages (`@typescript-eslint/types`, `@typescript-eslint/scope-manager`) propagated, leaving a window where fresh installs couldn't resolve them. npm has since healed.

- **Pinned `typescript-eslint` to exact `8.56.1`** (dropped the `^` caret) in `package.json` so CI no longer floats into a broken or unexpected upstream release. Lint-only devDependency; zero runtime impact. All three suites pass (5479 unit, 59 TCP, 36 embedded).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.21](/blog/bunqueue-v2-7-21/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.22) · [Commits since v2.7.20](https://github.com/egeominotti/bunqueue/compare/v2.7.20...v2.7.22) · [Full changelog](/changelog/) · [All posts](/blog/)
