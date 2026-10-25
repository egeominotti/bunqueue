---
title: "bunqueue v2.8.37"
description: "Fixes 4 bugs. The Go conformance job now enters the nested driver module explicitly with go -C drivers/go run .."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-37.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-17"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.37</em></h1>
  <p class="bq-hero-sub">Fixes 4 bugs. The Go conformance job now enters the nested driver module explicitly with go -C drivers/go run ..</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.37

```bash title="bun"
bun add bunqueue@2.8.37
```

```bash title="npm"
npm install bunqueue@2.8.37
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- The Go conformance job now enters the nested driver module explicitly with
  `go -C drivers/go run .`. Running `go run ./drivers/go` from
  `sdk/conformance` searched for a parent `go.mod` and failed before the driver
  could connect to the broker.
- A regression test now verifies the workflow command itself. The isolated
  core-test image includes the SDK workflow file so the contract is exercised
  by `bun run test:sandbox` and cannot silently drift.
- The late-dependency TCP regression now delegates port allocation to the
  kernel instead of guessing an unreserved high port, eliminating an
  `EADDRINUSE` race in the parallel unit gate.
- The testing and conformance references now document the runner working
  directory, the native CI command, and the prebuilt driver used by
  `test:sandbox:sdk`.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.36](/blog/bunqueue-v2-8-36/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.37) · [Commits since v2.8.36](https://github.com/egeominotti/bunqueue/compare/v2.8.36...v2.8.37) · [Full changelog](/changelog/) · [All posts](/blog/)
