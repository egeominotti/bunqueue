---
title: "bunqueue v2.8.55"
description: "Preserved DLQ automatic-retry history, retry count, expiry and backoff across repeated terminal failures and broker restarts."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-55.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-08-01"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.55</em></h1>
  <p class="bq-hero-sub">Preserved DLQ automatic-retry history, retry count, expiry and backoff across repeated terminal failures and broker restarts.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

## Engine correctness

- Preserved DLQ automatic-retry history, retry count, expiry and backoff across
  repeated terminal failures and broker restarts. SQLite now moves each retried
  generation from `dlq` to `jobs` atomically and durably removes capacity-evicted
  entries.
- Classified processing timeouts as `timeout` through retry history and the
  final DLQ entry without changing the public failure API or contaminating a
  later explicit processor failure.
- Wired the cloud `s3:backup` command through the live server context so a
  requested backup reaches the configured backup manager.
- Forwarded custom rate-limit durations from the TypeScript and Python SDKs,
  restoring the requested limiter window instead of silently using the broker
  default.

## Architecture

- Split QueueManager, Queue, Worker, SandboxedWorker, TCP transport, SQLite,
  server routing, scheduler, domain structures, MCP, CLI and benchmark logic
  into focused implementation modules while retaining their stable public
  façades and behavior.
- Moved public and internal contracts into dedicated `types/` modules. Every
  runtime TypeScript source file is now at most 300 lines, with automated gates
  for the ceiling, façade size, type-module presence and documentation links.

## Documentation and verification

- Audited all 33 requested Queue, Worker, Cron and DLQ guide sections and added
  discoverable real TCP and embedded evidence for every section. Shared parity
  contracts now cover DLQ maintenance, stall detection, queue groups,
  namespaces, rate-limit windows, timeouts and worker lifecycle.
- Replaced permissive integration assertions with exact state, count, ordering,
  retry and lifecycle checks, including real TCP SandboxedWorker execution and
  the actual 60-second DLQ maintenance timer.
- Completed every audited multi-language example group with Bun, Node.js/Deno,
  Python, PHP, Go, Rust and Elixir tabs, guarded by an executable documentation
  test.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.54](/blog/bunqueue-v2-8-54/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.55) · [Commits since v2.8.54](https://github.com/egeominotti/bunqueue/compare/v2.8.54...v2.8.55) · [Full changelog](/changelog/) · [All posts](/blog/)
