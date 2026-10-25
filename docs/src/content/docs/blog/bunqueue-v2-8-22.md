---
title: "bunqueue v2.8.22"
description: "bunqueue 2.8.22 release notes."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-22.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-23"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.22</em></h1>
  <p class="bq-hero-sub">bunqueue 2.8.22 release notes.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.22

```bash title="bun"
bun add bunqueue@2.8.22
```

```bash title="npm"
npm install bunqueue@2.8.22
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

A dependent job created by `FlowProducer.addChain()` (e.g. `B` and `C` in a chain `A → B → C`) is parked in `shard.waitingDeps` (state `waiting-children`) until its predecessors complete. Its `jobIndex` location is `{ type: 'queue' }`, but `cancelJob()` only inspected the run queue and the `waitingChildren` map, it never checked `waitingDeps`. So `Queue.removeAsync(id)` (and `job.remove()`) on such a job returned `false`, **never called `storage.deleteJob()`**, and left the row in SQLite: the job reappeared after a server restart, leaking the dependency-index entry and its `uniqueKey` reservation too.

`cancelJob()` now handles the `waitingDeps` case: it deletes the job from `waitingDeps`, unregisters its dependency-index entries, releases any held `uniqueKey`, drops it from `jobIndex`, and calls `storage.deleteJob()` (which also evicts a still-buffered job from the write buffer). It does **not** touch the queued counter, `waitingDeps` jobs are never counted there. RED→GREEN reproduction in `test/issue-102-cancel-waitingdeps.test.ts`: a `QueueManager` + real SQLite restart proving the row is gone and does not reappear, a `uniqueKey`-reuse-after-cancel case, and a faithful `FlowProducer.addChain` + `removeAsync` embedded repro.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.21](/blog/bunqueue-v2-8-21/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.22) · [Commits since v2.8.21](https://github.com/egeominotti/bunqueue/compare/v2.8.21...v2.8.22) · [Full changelog](/changelog/) · [All posts](/blog/)
