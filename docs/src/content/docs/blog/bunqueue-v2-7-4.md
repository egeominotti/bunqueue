---
title: "bunqueue v2.7.4"
description: "Crash recovery, type-safe workflow steps."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-4.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-13"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.4</em></h1>
  <p class="bq-hero-sub">Crash recovery, type-safe workflow steps.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.4

```bash title="bun"
bun add bunqueue@2.7.4
```

```bash title="npm"
npm install bunqueue@2.7.4
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Crash recovery

New `engine.recover()` re-enqueues orphaned executions after crash/restart. Handles three states: `running` (re-enqueue at current step), `waiting` (re-arm signal timeout or resume if signal arrived), `compensating` (re-run compensation). Returns `RecoverResult` with counts.

## Type-safe workflow steps

`Workflow<TInput>` now uses a generic accumulator pattern to track step return types at compile time. Each `.step()` narrows the return type so subsequent steps see previous results without `as` casts. Works with `.parallel()`, `.map()`, `.forEach()`, `.subWorkflow()`. Fully backward compatible.

## More additions

- New `src/client/workflow/compensator.ts`, Extracted `WaitForSignalError` and `runCompensation()` from executor.
- New `src/client/workflow/recovery.ts`, Recovery logic with `RecoverDeps` interface and `recoverExecutions()`.
- New `WorkflowStore.listRecoverable()` method, Queries SQLite for executions in recoverable states.
- Exported `RecoverResult`, `TypedStepHandler`, `TypedCompensateHandler` from `bunqueue/workflow`.

## Documentation

- **Workflow guide**: Added "Type-Safe Steps" and "Crash Recovery" sections, updated comparison table (+2 rows), updated Quick Start with type-safe examples, updated StepContext table, updated Limitations & Caveats, added `engine.recover()` to API table.

## Tests

- 7 new crash recovery tests (`test/workflow-recovery.test.ts`)
- 8 new type-safe step tests (`test/workflow-typesafe.test.ts`)

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.3](/blog/bunqueue-v2-7-3/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.4) · [Commits since v2.7.3](https://github.com/egeominotti/bunqueue/compare/v2.7.3...v2.7.4) · [Full changelog](/changelog/) · [All posts](/blog/)
