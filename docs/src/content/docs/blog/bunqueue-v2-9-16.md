---
title: "bunqueue v2.9.16"
description: "Fixes 7 bugs. MCP bulk retry confirmation cannot be bypassed with an empty job ID."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-16.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-15"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.16</em></h1>
  <p class="bq-hero-sub">Fixes 7 bugs. MCP bulk retry confirmation cannot be bypassed with an empty job ID.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.9.16

```bash title="bun"
bun add bunqueue@2.9.16
```

```bash title="npm"
npm install bunqueue@2.9.16
```

```bash title="docker"
TAG=2.9.16
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- MCP bulk retry confirmation cannot be bypassed with an empty job ID. ACK,
  failure and batch tools preserve ignored broker outcomes, and monitoring keeps
  valid prototype-like queue names.
- CLI boolean flags preserve explicit `false`, argument terminators protect
  literal values, and job listing accepts every public state. DLQ output uses
  authoritative errors and timestamps; default waits allow the broker to finish.
- Health checks produce structured JSON on success and failure, diagnostic URLs
  support IPv6, and progress aliases and worker guidance match supported APIs.
- Standalone MCP verification uses the maintained assertion suites with bounded
  subprocesses and isolated configuration instead of misclassifying tool outcomes.
- S3 retention preserves the newest timestamped backup when modification times
  tie. Retry decisions honor service error codes, and local deadlines cannot
  start overlapping uncancellable operations.
- SQLite restore makes committed WAL data recoverable before detaching sidecars,
  preserving the original state if the process is interrupted before installation.
  Busy or unsafe recovery refuses the replacement; corruption tests now reach the
  intended SQLite integrity check.
- Pull-cadence regressions check repeated scheduling decisions instead of assuming
  a fixed number of timer deliveries within a short wall-clock window. Changed
  test fixtures and their shared stream helper are checked against the actual API types.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.15](/blog/bunqueue-v2-9-15/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.16) · [Commits since v2.9.15](https://github.com/egeominotti/bunqueue/compare/v2.9.15...v2.9.16) · [Full changelog](/changelog/) · [All posts](/blog/)
