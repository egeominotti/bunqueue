---
title: "bunqueue v2.6.77"
description: "Fixes 1 bug. removeChildDependency() TCP response now returns { ok: true, removed: boolean } separately; client reads res.removed instead of res.ok to correctly reflect whether the dependency was actually removed"
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-77.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-24"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.77</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. removeChildDependency() TCP response now returns { ok: true, removed: boolean } separately; client reads res.removed instead of res.ok to correctly reflect whether the dependency was actually removed</p>
</div>

#### To install bunqueue v2.6.77

```bash title="bun"
bun add bunqueue@2.6.77
```

```bash title="npm"
npm install bunqueue@2.6.77
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- `removeChildDependency()` TCP response now returns `{ ok: true, removed: boolean }` separately; client reads `res.removed` instead of `res.ok` to correctly reflect whether the dependency was actually removed

---

[← bunqueue v2.6.76](/blog/bunqueue-v2-6-76/) · [Full changelog](/changelog/) · [All posts](/blog/)
