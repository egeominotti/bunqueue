---
title: "bunqueue v2.5.7"
description: "SandboxedWorker TCP mode, sandboxedWorker EventEmitter, queueOps adapter, TCP heartbeat for SandboxedWorker."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-5-7.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-01"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.5.7</em></h1>
  <p class="bq-hero-sub">SandboxedWorker TCP mode, sandboxedWorker EventEmitter, queueOps adapter, TCP heartbeat for SandboxedWorker.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

## SandboxedWorker TCP mode

SandboxedWorker now supports connecting to a remote bunqueue server via TCP, enabling crash-isolated job processing in server deployments (systemd, Docker). Pass `connection` option to enable it.

## SandboxedWorker EventEmitter

SandboxedWorker now extends EventEmitter with full event support: `ready`, `active`, `completed`, `failed`, `progress`, `error`, `closed` (matching regular Worker API).

## QueueOps adapter

(`src/client/sandboxed/queueOps.ts`), unified interface for embedded and TCP queue operations, keeping SandboxedWorker code clean and dual-mode.

## TCP heartbeat for SandboxedWorker

Automatic lock renewal via `JobHeartbeat` commands for active jobs in TCP mode (configurable via `heartbeatInterval`).

## More additions

- TCP integration test for SandboxedWorker (`scripts/tcp/test-sandboxed-worker.ts`)
- 8 new unit tests for SandboxedWorker events and TCP constructor

## Documentation

- Updated Worker guide with SandboxedWorker TCP mode section and events documentation
- Updated CPU-Intensive Workers guide with SandboxedWorker TCP example

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.5.6](/blog/bunqueue-v2-5-6/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.5.7) · [Commits since v2.5.6](https://github.com/egeominotti/bunqueue/compare/v2.5.6...v2.5.7) · [Full changelog](/changelog/) · [All posts](/blog/)
