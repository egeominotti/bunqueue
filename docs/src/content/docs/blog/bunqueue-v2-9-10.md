---
title: "bunqueue v2.9.10"
description: "Fixes 1 bug. A wait TTL longer than about 24.8 days now lasts the whole TTL."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-10.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-03"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.10</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. A wait TTL longer than about 24.8 days now lasts the whole TTL.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.9.10

```bash title="bun"
bun add bunqueue@2.9.10
```

```bash title="npm"
npm install bunqueue@2.9.10
```

```bash title="docker"
TAG=2.9.10
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **A wait TTL longer than about 24.8 days now lasts the whole TTL.**
  `Queue.waitJobUntilFinished()` and `job.waitUntilFinished()` with a TTL above
  2^31 - 1 ms rejected within milliseconds with `timed out after <ttl>ms` when
  the job was still pending, and printed a `TimeoutOverflowWarning`: Bun and
  Node.js fire a longer timer after 1 ms. The deadline is now armed in chunks
  of at most 24 days, each measured against the clock, so the wait runs until
  the TTL really elapses, in embedded and TCP mode, with or without
  `QueueEvents`. `bunqueue-client` gets this fix with its next release; 0.2.2
  still has the limit.

## Tests

- **Docker tags in the docs follow the release version.**
  `test/docs-docker-tags-version.test.ts` fails when the README or a guide
  pins an image tag other than the version in `package.json`, so a release can
  no longer ship docs that point at the previous images.
- `test/repro-wait-long-ttl.test.ts` reproduces the TTL bug in both modes, and
  `test/job-wait-long-deadline.test.ts` checks the chunked deadline: it fires
  once and never early, clearing it cancels it, and a settled 30-day wait lets
  the process exit.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.9](/blog/bunqueue-v2-9-9/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.10) · [Commits since v2.9.9](https://github.com/egeominotti/bunqueue/compare/v2.9.9...v2.9.10) · [Full changelog](/changelog/) · [All posts](/blog/)
