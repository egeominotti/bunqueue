---
title: "bunqueue v2.7.0"
description: "Workflow Engine."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-7-0.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.7.0</em></h1>
  <p class="bq-hero-sub">Workflow Engine.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.7.0

```bash title="bun"
bun add bunqueue@2.7.0
```

```bash title="npm"
npm install bunqueue@2.7.0
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Workflow Engine

A new orchestration layer for multi-step business processes, built entirely on top of bunqueue's existing Queue and Worker. Zero core engine modifications, zero new infrastructure.
- **Fluent DSL**: Chain `.step()`, `.branch()`, `.path()`, and `.waitFor()` to define workflows in pure TypeScript
- **Saga compensation**: Attach `compensate` handlers to steps; on failure, they run automatically in reverse order, rolling back side effects (payments, reservations, database writes)
- **Conditional branching**: Route execution to different paths at runtime based on step results (e.g., VIP vs standard, risk-level tiers)
- **Human-in-the-loop**: `.waitFor('event')` pauses execution (persisted to SQLite); `engine.signal(id, event, payload)` resumes it, minutes, hours, or days later
- **Step timeouts**: Prevent steps from running indefinitely with per-step timeout configuration
- **Context passing**: Each step accesses the original input and all previous step results via `ctx.steps['step-name']`
- **SQLite persistence**: Execution state is stored in a dedicated `workflow_executions` table; survives process restarts
- **Embedded & TCP**: Works in both modes, just like Queue and Worker
- **Import**: `import { Workflow, Engine } from 'bunqueue/workflow'`
- **Export mapping**: added `"./workflow"` to package.json exports
```typescript
const flow = new Workflow('order')
  .step('validate', async (ctx) => { ... })
  .step('charge', async (ctx) => { ... }, {
    compensate: async () => { /* auto-rollback */ },
  })
  .waitFor('manager-approval')
  .step('ship', async (ctx) => { ... });

const engine = new Engine({ embedded: true });
engine.register(flow);
const run = await engine.start('order', { orderId: 'ORD-1' });
await engine.signal(run.id, 'manager-approval', { approved: true });
```

## Documentation

- **New page**: [Workflow Engine guide](/guide/workflow/) with competitor comparison (vs Temporal, Inngest, Trigger.dev), full API reference, and 4 production examples (e-commerce, CI/CD pipeline, KYC onboarding, ETL data pipeline)
- **Quickstart**: Added Workflow Engine section with example
- **README**: Added Workflow Engine section with code examples and competitor comparison table
- **Sidebar**: Added Workflow Engine entry under Client SDK
- **SEO**: Updated global keywords, JSON-LD structured data, and sitemap priority for workflow page

## Tests

- 27 new unit tests across 3 test files (`workflow-engine`, `workflow-realistic`, `workflow-e2e-production`)
- 7 new embedded integration tests (`scripts/embedded/test-workflow-engine.ts`)
- 6 new TCP integration tests (`scripts/tcp/test-workflow-engine.ts`)
- All 5274 existing tests continue to pass

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.116](/blog/bunqueue-v2-6-116/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.7.0) · [Commits since v2.6.116](https://github.com/egeominotti/bunqueue/compare/v2.6.116...v2.7.0) · [Full changelog](/changelog/) · [All posts](/blog/)
