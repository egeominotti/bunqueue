---
title: "bunqueue v2.8.2"
description: "bunqueue 2.8.2 release notes."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-2.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.2</em></h1>
  <p class="bq-hero-sub">bunqueue 2.8.2 release notes.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.2

```bash title="bun"
bun add bunqueue@2.8.2
```

```bash title="npm"
npm install bunqueue@2.8.2
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Stop shipping source maps: another −34% off the install

The published package included `*.js.map` and `*.d.ts.map` source maps (512 files,
2.8 MB) whose `sources` point at `src/*.ts`, which is **not** shipped in the
package. With no source to resolve against, those maps were dead weight on every
install. Disabled `sourceMap`/`declarationMap` in `tsconfig.build.json` so tsc
emits neither the maps nor the trailing `sourceMappingURL` comments (no dangling
references), and dropped the now-empty `*.map` globs from `files[]`.

| Metric              | 2.8.1  | 2.8.2  | Delta              |
| ------------------- | ------ | ------ | ------------------ |
| `node_modules` size | 8.2 MB | 5.4 MB | **−2.8 MB (−34%)** |
| `bunqueue` package  | 5.8 MB | 3.0 MB | −48%               |
| files in package    | 1027   | 503    | −524               |
| tarball (download)  | 664 KB | 409 KB | −38%               |

No runtime change. Cumulative since 2.7.x: a clean `bun add bunqueue` went from
**94 MB / 117 packages to 5.4 MB / 7 packages (−94%)**.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.1](/blog/bunqueue-v2-8-1/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.2) · [Commits since v2.7.22](https://github.com/egeominotti/bunqueue/compare/v2.7.22...v2.8.2) · [Full changelog](/changelog/) · [All posts](/blog/)
