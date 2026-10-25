---
title: "bunqueue v2.8.61"
description: "Fixes 1 bug. Fixed the order-dependent Linux release failure where persistent embedded suites inherited a process-wide in-memory QueueManager before selecting their SQLite database."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-61.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-08-22"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.61</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Fixed the order-dependent Linux release failure where persistent embedded suites inherited a process-wide in-memory QueueManager before selecting their SQLite database.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

## Changes

- Updated the repository agent instructions so every commit contains a
  corresponding changelog update and uses a concise, specific English
  description as its mandatory message. Pushes now verify outgoing commits
  without starting another changelog cycle; version bumps and package
  publication remain separate actions requiring explicit authorization.

## Bugfixes

- Fixed the order-dependent Linux release failure where persistent embedded
  suites inherited a process-wide in-memory QueueManager before selecting
  their SQLite database. The affected Workflow, Worker, and stacktrace suites
  now claim the singleton at file entry and release it only after their clients
  close. A dedicated regression guard locks both suite boundaries.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.60](/blog/bunqueue-v2-8-60/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.61) · [Commits since v2.8.59](https://github.com/egeominotti/bunqueue/compare/v2.8.59...v2.8.61) · [Full changelog](/changelog/) · [All posts](/blog/)
