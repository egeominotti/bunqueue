---
title: "bunqueue v2.7.2"
description: "Loop control flow, forEach iteration, map transform, schema validation and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-2.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.2</em></h1>
  <p class="bq-hero-sub">Loop control flow, forEach iteration, map transform, schema validation and more.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.2

```bash title="bun"
bun add bunqueue@2.7.2
```

```bash title="npm"
npm install bunqueue@2.7.2
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Loop control flow

New `.doUntil(condition, builder, opts?)` and `.doWhile(condition, builder, opts?)` DSL methods for conditional iteration. `doUntil` runs steps then checks condition (do...until), `doWhile` checks condition first (while...do). Both support `maxIterations` safety limit (default: 100).

## forEach iteration

New `.forEach(items, name, handler, opts?)` iterates over a dynamic item list. Results stored with indexed names (`step:0`, `step:1`, ...). Each iteration receives `ctx.steps.__item` and `ctx.steps.__index`. Supports `maxIterations` (default: 1000).

## Map transform

New `.map(name, transformFn)` for synchronous data transforms between steps. No retry, no timeout, pure computation node.

## Schema validation

New `inputSchema` and `outputSchema` options on `.step()`. Duck-typed `.parse()` method, works with Zod, ArkType, Valibot, or any custom schema. Input validated before handler, output validated after.

## Per-execution subscribe

New `engine.subscribe(executionId, callback)` returns an unsubscribe function. Filters events for a specific execution only.

## More additions

- New `src/client/workflow/loops.ts`, Dedicated execution logic for doUntil, doWhile, forEach, and map nodes.

## Documentation

- **Workflow guide**: 6 new Core Concepts sections (Loops, forEach, Map, Schema Validation, Subscribe), 5 new comparison table rows, subscribe added to API table, architecture diagram updated, 2 new real-world examples
- **Blog post**: 2 new sections (Loops/forEach/Map, Schema/Subscribe), test count updated
- **Examples**: 3 new examples (forEach+Map aggregation, doUntil polling, Schema+Subscribe)
- **FAQ**: Feature list expanded (+5 bullets), comparison table (+3 rows), JSON-LD updated
- **Homepage/Introduction/README/CLAUDE.md**: All updated with new features

## Tests

- 11 new unit tests in `workflow-loops.test.ts` (doUntil, doWhile, forEach, map, subscribe, schema validation)
- 6 new embedded integration tests (tests 14-19)
- 6 new TCP integration tests (tests 14-19)
- Fixed flaky `workflow-realistic.test.ts` (added `retry: 1` to failing step)
- All 5,305 existing tests continue to pass

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.7.1](/blog/bunqueue-v2-7-1/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.2) · [Commits since v2.7.1](https://github.com/egeominotti/bunqueue/compare/v2.7.1...v2.7.2) · [Full changelog](/changelog/) · [All posts](/blog/)
