---
title: "bunqueue v2.9.17"
description: "Release artifacts and CI run on Bun 1.4.4 (previously 1.4.3)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-17.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-22"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.17</em></h1>
  <p class="bq-hero-sub">Release artifacts and CI run on Bun 1.4.4 (previously 1.4.3).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.9.17

```bash title="bun"
bun add bunqueue@2.9.17
```

```bash title="npm"
npm install bunqueue@2.9.17
```

```bash title="docker"
TAG=2.9.17
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- Release artifacts and CI run on Bun 1.4.4 (previously 1.4.3). The standalone
  executables and Docker images are compiled with it, and the main CI, the SDK
  workflows, the release builder image and the disposable test images pin it.
  The npm package's runtime requirement is unchanged (`bun >= 1.4.0`).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.16](/blog/bunqueue-v2-9-16/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.17) · [Commits since v2.9.16](https://github.com/egeominotti/bunqueue/compare/v2.9.16...v2.9.17) · [Full changelog](/changelog/) · [All posts](/blog/)
