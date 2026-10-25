---
title: "bunqueue v2.8.23"
description: "Fixes 2 bugs. updateJobParent corrupted a child's parentQueue (src/application/queueManager.ts)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-23.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-24"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.23</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. updateJobParent corrupted a child's parentQueue (src/application/queueManager.ts).</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.23

```bash title="bun"
bun add bunqueue@2.8.23
```

```bash title="npm"
npm install bunqueue@2.8.23
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

An adversarial audit of every `FlowProducer` feature (new suite `test/flow-producer-audit.test.ts`, 15 tests) confirmed 13 behaviors correct and surfaced two genuine bugs, both fixed RED→GREEN:

- **`updateJobParent` corrupted a child's `__parentQueue`** (`src/application/queueManager.ts`). It set `data.__parentQueue = childJob.queue`, the **child's own** queue, instead of the parent's. For a **cross-queue** flow (`add({ queueName: 'P', children: [{ queueName: 'C' }] })`) the child's `Queue.getJob(...).parent.queueQualifiedName`, `.parentKey`, `.opts.parent.queue`, and `toJSON()/asJSON().parentKey` all reported `C` instead of `P`, breaking child→parent navigation. (Execution, `getChildrenValues`, `getFlow`, and `failParentOnFailure` were unaffected, they key off the domain `parentId`, which was already correct, so same-queue flows masked the bug.) Now set from `parentJob.queue`. `Queue.add({ parent })` already did this correctly (`add.ts`); `updateJobParent` was the lone divergence.

- **`addBulkThen` produced a merge job that could not read its predecessors** (`src/client/flow.ts`). The `final` job was pushed via `pushJob` with `dependsOn = parallelIds` but **no `childrenIds`**, so `getChildrenValues(finalId)` returned `{}`, incompatible with BullMQ fan-in and with `add()`. It now pushes the final job via `pushJobWithParent` (children = the parallel ids): identical `dependsOn` ordering (still waits for all parallel jobs), but the merge step can now read their results via `getChildrenValues()` / `getDependencies()`. Note the linkage side effect: the parallel jobs now have the final job as their `parentId`, so a parallel step carrying `failParentOnFailure: true` will now fail the merge job (previously a silent no-op, since the parallel jobs had no parent).

Two further audit candidates were investigated and **deliberately not changed** because they are not bugs: `getParentResult` returning `undefined` when a predecessor used `removeOnComplete: true` is an intentional memory-bounding trade-off (dependents still unblock via `depCompletions`), and the embedded-vs-TCP `customId`/`deduplication.id` fallback difference is not FlowProducer-specific, it mirrors the direct `Queue.add` paths. Regression-checked across 101 existing flow tests + all three suites (unit 5680, TCP 59/59, embedded 36/36).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.22](/blog/bunqueue-v2-8-22/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.23) · [Commits since v2.8.22](https://github.com/egeominotti/bunqueue/compare/v2.8.22...v2.8.23) · [Full changelog](/changelog/) · [All posts](/blog/)
