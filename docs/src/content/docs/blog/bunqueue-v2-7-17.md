---
title: "bunqueue v2.7.17"
description: "Fixes 2 bugs. Created job has wrong priority / options not reflected in TCP mode (#88): await queue.add(name, data, { priority: 10 }) returned job.priority === 0 over TCP."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-17.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-05-30"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.17</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Created job has wrong priority / options not reflected in TCP mode (#88): await queue.add(name, data, { priority: 10 }) returned job.priority === 0 over TCP.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.17

```bash title="bun"
bun add bunqueue@2.7.17
```

```bash title="npm"
npm install bunqueue@2.7.17
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- TCP job payloads now omit `undefined`-valued keys, keeping large bulk frames compact (a 1000-job bulk payload dropped from ~446 KB to ~320 KB), which also avoids an intermittent large-frame delivery stall under load.

## Bugfixes

- **Created job has wrong priority / options not reflected in TCP mode (#88)**: `await queue.add(name, data, { priority: 10 })` returned `job.priority === 0` over TCP. The Job object returned by `add()`/`addBulk()` (and `getJob()`/`getJobs()`) is built client-side by `createJobProxy`/`createSimpleJob`, which hardcoded `priority: 0`, `delay: 0`, `opts: {}`. These now reflect the requested/stored options (`priority`, `delay`, `opts`). Embedded `add()` was already correct (it uses `toPublicJob`).
- **TCP `add()` silently dropped job options**: the single-job TCP `PUSH` path forwarded only a subset of options, so `deduplication`, `ttl`, `tags`, `groupId`, `lifo`, `keepLogs`, `sizeLimit`, `stackTraceLimit`, `debounce`, `dependsOn`, `failParentOnFailure`, `removeDependencyOnFailure`, `continueParentOnFailure`, `ignoreDependencyOnFailure` and `timestamp` were ignored when adding a single job over TCP. The `PUSH` command and its handler now carry and apply the full option set, matching embedded mode and bulk add. `addBulk` forwarding gaps (`removeOnComplete`/`removeOnFail`, parent, dedup, tags, groupId, dependsOn) were closed too.

## Notes

- `getJobsAsync()` returns a slim `opts` (`{}`) for listed jobs, whereas `getJob()` returns the full `opts`. The reflected `delay` tracks current scheduling (`runAt - createdAt`), so after a retry/backoff it reflects the next run, not the originally requested delay.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.16](/blog/bunqueue-v2-7-16/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.17) · [Commits since v2.7.16](https://github.com/egeominotti/bunqueue/compare/v2.7.16...v2.7.17) · [Full changelog](/changelog/) · [All posts](/blog/)
