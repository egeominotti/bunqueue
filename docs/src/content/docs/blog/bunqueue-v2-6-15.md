---
title: "bunqueue v2.6.15"
description: "Full HTTP REST API parity with TCP protocol, HTTP route architecture, HTTP API documentation rewritten."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-15.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-14"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.15</em></h1>
  <p class="bq-hero-sub">Full HTTP REST API parity with TCP protocol, HTTP route architecture, HTTP API documentation rewritten.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.15

```bash title="bun"
bun add bunqueue@2.6.15
```

```bash title="npm"
npm install bunqueue@2.6.15
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Full HTTP REST API parity with TCP protocol

All 76 TCP commands are now accessible via HTTP endpoints. Previously only 17 endpoints were available. New endpoints include:
- **Job management**: promote, update data, get state, get result, get/update progress, change priority, discard to DLQ, move to delayed, change delay, wait for completion, get children values
- **Job logs**: add, get, and clear structured logs per job
- **Job locking**: heartbeat, extend lock, batch heartbeat, batch extend locks
- **Batch operations**: bulk push (`PUSHB`), batch pull (`PULLB`), batch acknowledge (`ACKB`)
- **Queue control**: list queues, list jobs by state, job counts, priority counts, pause/resume, drain, obliterate, clean with grace period, promote all delayed, retry completed
- **DLQ**: list DLQ jobs, retry (single or all), purge
- **Rate limiting & concurrency**: set/clear per-queue rate limits and concurrency limits
- **Queue configuration**: get/set stall detection config, get/set DLQ config
- **Cron jobs**: full CRUD (list, add, get, delete)
- **Webhooks**: full CRUD (list, add, remove, enable/disable)
- **Workers**: list, register, unregister, worker heartbeat
- **Monitoring**: ping, storage status

## HTTP route architecture

Routes split into 4 files (`httpRouteJobs.ts`, `httpRouteQueues.ts`, `httpRouteQueueConfig.ts`, `httpRouteResources.ts`) for maintainability.

## HTTP API documentation rewritten

Enterprise-grade docs with curl examples, full request/response specs, parameter tables, and error cases for every endpoint (1,640 lines).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.14](/blog/bunqueue-v2-6-14/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.15) · [Commits since v2.6.14](https://github.com/egeominotti/bunqueue/compare/v2.6.14...v2.6.15) · [Full changelog](/changelog/) · [All posts](/blog/)
