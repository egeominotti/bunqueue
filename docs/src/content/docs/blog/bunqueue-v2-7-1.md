---
title: "bunqueue v2.7.1"
description: "Step retry with exponential backoff, parallel steps, signal timeout, nested workflows (sub-workflows) and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-1.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-10"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.1</em></h1>
  <p class="bq-hero-sub">Step retry with exponential backoff, parallel steps, signal timeout, nested workflows (sub-workflows) and more.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.1

```bash title="bun"
bun add bunqueue@2.7.1
```

```bash title="npm"
npm install bunqueue@2.7.1
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Step retry with exponential backoff

Steps now retry automatically with configurable `retry` count. Backoff uses `min(500ms × 2^attempt + jitter, 30s)`. Attempt count tracked in `exec.steps['name'].attempts`.

## Parallel steps

New `.parallel()` DSL method runs multiple steps concurrently via `Promise.allSettled`. If any step fails, compensation runs for all completed steps.

## Signal timeout

`.waitFor('event', { timeout: ms })` fails the execution if the signal doesn't arrive within the timeout, triggering compensation automatically.

## Nested workflows (sub-workflows)

New `.subWorkflow(name, inputMapper)` composes workflows. Parent pauses while child executes; child results available in `ctx.steps['sub:<name>']`.

## Observability (typed events)

New `WorkflowEmitter` with 11 event types: `workflow:started/completed/failed/waiting/compensating`, `step:started/completed/failed/retry`, `signal:received/timeout`. Subscribe via `engine.on()`, `engine.onAny()`, or `onEvent` constructor option.

## Cleanup & archival

`engine.cleanup(maxAgeMs, states?)` deletes old executions. `engine.archive(maxAgeMs, states?)` moves them to `workflow_executions_archive` table (transactional, up to 1000 per call). `engine.getArchivedCount()` returns archive size.

## Changes

- Refactored `executor.ts` (362→273 lines): extracted `buildContext()`, `findStepDef()`, `executeStepWithRetry()`, `executeParallelSteps()`, `executeSubWorkflow()` to new `runner.ts`
- New `emitter.ts` (115 lines) for event system
- `processStep()` now allows `'waiting'` state (for signal timeout re-checks)

## Documentation

- **Workflow guide**: Added 6 new sections (retry, parallel, signal timeout, nested, observability, cleanup), updated comparison table (+6 rows), API table (+7 methods), architecture diagram
- **Blog post**: Added sections for retry/parallel/sub-workflows, observability, cleanup
- **Examples**: Added 3 new workflow examples (parallel enrichment, nested sub-workflow, retry with observability)
- **FAQ**: Updated feature list, comparison table, JSON-LD schema
- **Homepage/Introduction/README**: Updated feature descriptions

## Tests

- 20 new unit tests in `workflow-new-features.test.ts` (retry, parallel, signal timeout, cleanup, observability, nested workflows)
- 6 new embedded integration tests (tests 8-13 in `scripts/embedded/test-workflow-engine.ts`)
- 7 new TCP integration tests (tests 7-13 in `scripts/tcp/test-workflow-engine.ts`)
- All 5,294 existing tests continue to pass

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.0](/blog/bunqueue-v2-7-0/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.1) · [Commits since v2.7.0](https://github.com/egeominotti/bunqueue/compare/v2.7.0...v2.7.1) · [Full changelog](/changelog/) · [All posts](/blog/)
