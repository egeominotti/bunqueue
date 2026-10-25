---
title: "bunqueue v2.9.15"
description: "Fixes 4 bugs. Agent-oriented MCP inspection, structured MCP contracts, agent preset and readiness checks, optional bunqueue/agents entrypoint and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-15.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.15</em></h1>
  <p class="bq-hero-sub">Fixes 4 bugs. Agent-oriented MCP inspection, structured MCP contracts, agent preset and readiness checks, optional bunqueue/agents entrypoint and more.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.9.15

```bash title="bun"
bun add bunqueue@2.9.15
```

```bash title="npm"
npm install bunqueue@2.9.15
```

```bash title="docker"
TAG=2.9.15
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Agent-oriented MCP inspection

`bunqueue_diagnose_queue` accounts for all
queue states and reports observed limits and blockers, `bunqueue_observe_job`
distinguishes completion, failure and unknown jobs with bounded polling, and
`bunqueue_list_jobs_page` provides bounded offset pages with explicit projection
and truncation metadata. Scoped queue/job resource templates avoid broad reads.

## Structured MCP contracts

Registered tools expose policy annotations,
output schemas and structured outcomes alongside existing text responses.
Dynamic discovery includes complete descriptors, and
`bunqueue_get_capabilities` reports effective server settings and tools.

## Agent preset and readiness checks

`BUNQUEUE_MCP_PROFILE=agent` enables
dynamic discovery and destructive-operation confirmation when those settings
were not explicitly supplied. `bunqueue-mcp --doctor --json` checks configuration,
paths and TCP readiness without starting consumers or opening workflow SQLite.

## Optional `bunqueue/agents` entrypoint

Provider-neutral turn consumption,
a Claude message adapter and an independent SQLite journal support durable
session checkpoints, bounded progress replay and stable external-effect keys.
Pending effects require reconciliation before a retry; provider artifacts and
cooperative cancellation remain application responsibilities.

## Executable integration guidance and offline evaluations

Claude, OpenAI
Agents and Mastra examples use caller/CLI model configuration. Five real-MCP
scenarios run against embedded and TCP backends with independent state checks.
Catalog measurements include schemas and annotations; deterministic task scores
are not live-model success rates. Workflow/agent skills and public API references
now expose the integration contracts.

## Compatibility

- Queue scheduling, queue persistence and workflow engine behavior remain unchanged.
  Existing MCP listing/wait tools and text results remain available. The agents
  helper is optional and Bun-only, imports no provider SDK and uses its own database.

## Bugfixes

- MCP diagnostic prompts omitted prioritized, paused and dependency-blocked work
  from their accounting and could imply an unobserved cause. They now report
  complete counts, observed limits and bounded samples.
- MCP write errors after a potentially committed operation could look safely
  retryable. Structured errors preserve uncertainty and require reconciliation;
  pre-dispatch refusals remain distinguishable from attempted writes.
- Agent examples could silently accept provider errors or interrupted streams,
  share effect state between concurrent runs, or replace an explicit structured
  `null` result with text. Typed terminal outcomes, per-run effect identity and
  output validation now preserve those contracts.
- Documentation discovery validation accepts the independently validated
  `llms-full.txt` resource while continuing to reject non-canonical page links
  and unknown text resources.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.14](/blog/bunqueue-v2-9-14/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.15) · [Commits since v2.9.14](https://github.com/egeominotti/bunqueue/compare/v2.9.14...v2.9.15) · [Full changelog](/changelog/) · [All posts](/blog/)
