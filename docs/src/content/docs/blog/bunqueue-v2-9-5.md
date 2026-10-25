---
title: "bunqueue v2.9.5"
description: "Publish Alpine, Debian 13, Debian slim, and distroless variants to Docker Hub and GHCR for Linux amd64 and arm64."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-5.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-09-09"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.5</em></h1>
  <p class="bq-hero-sub">Publish Alpine, Debian 13, Debian slim, and distroless variants to Docker Hub and GHCR for Linux amd64 and arm64.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.9.5

```bash title="bun"
bun add bunqueue@2.9.5
```

```bash title="npm"
npm install bunqueue@2.9.5
```

```bash title="docker"
TAG=2.9.5
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Docker distribution variants

- Publish Alpine, Debian 13, Debian slim, and distroless variants to Docker Hub
  and GHCR for Linux amd64 and arm64. Keep unsuffixed version and latest tags on
  Alpine, with a shared non-root UID and persistent data volume.
- Remove the separate Bun runtime and build dependencies from production images.
  Add the shell-free `healthcheck [url]` HTTP probe for every variant.
- Require native image checks for authentication, health, and SQLite recovery
  before publishing the exact tested images. Allow explicitly requested Docker
  rebuilds of an existing version through the full CI gates.
- Fail closed on Git tag lookup errors and add an explicit, version-checked root
  npm publication input that waits for all product and image checks.
- Pass npm credentials through Bun's native `NPM_CONFIG_TOKEN` variable so the
  CI authentication check and tarball publication receive the configured token.
- Keep Docker Hub tags limited to release versions and variant aliases. Retain
  build references on GHCR and stop generating timestamp tags.
- Explain Docker base-image differences in the README and add a homepage Docker
  quickstart with variant selection, copyable commands and persistent storage.

## Canonical client parity

- Build `bunqueue-client` from the canonical Bun client source, sharing Queue,
  Worker, Job, FlowProducer, QueueEvents, QueueGroup, Simple Mode, groups,
  processor batches, options, errors, events, and return contracts. Preserve
  the historical SDK API at the explicit `/legacy` entry.
- Block source/artifact drift and public declaration differences during the
  SDK build. Run shared native contracts, differential generated histories,
  and real package scenarios in Bun, Node, Deno, and Workers.
- Keep TCP clients from initializing local embedded storage during DLQ reads
  and asynchronous QueueGroup discovery.
- Preserve embedded shard selection under container CPU quotas, reject
  unreviewed Bun runtime access in portable builds, and verify strict NodeNext
  declarations plus sandboxed processors across the supported runtimes.
- Make archive cutoff regressions deterministic on Linux while retaining
  mutation coverage of the inclusive timestamp boundary.
- Audit the introductory, Queue, and Worker guides; correct token-bound
  transitions, bulk-admission semantics, option references, SDK examples,
  and empty table headings.

## Queue and SDK performance

- Flow creation now batches its telemetry writes after the atomic graph commit,
  preserving per-node routing and event order while removing repeated storage
  transaction overhead.
- Workflow-engine control jobs now use `removeOnComplete` by default, so
  completed internal orchestration jobs do not consume the shared completed-job
  retention budget. User workflow jobs and workflow state remain unchanged.
- The TypeScript and Python network SDKs now wake saturated pull loops as soon
  as a job settles. In the native 20,000-job workload, median Worker time fell
  by 48.3% and 76.2% respectively without changing ACK/FAIL, heartbeat, lease,
  concurrency, or shutdown semantics.

## PostgreSQL performance

- Batched worker heartbeats now renew every valid fenced lease in one
  transaction and apply successful versions locally; invalid fences share one
  repair query instead of creating per-job transactions and projection reloads.
  Pre-write generation tickets prevent delayed heartbeat or batch-ACK responses
  from overwriting a newer completed, removed, retried, or re-leased projection.
- PostgreSQL event retention now consolidates exact transaction-private deltas
  into per-queue state and deletes only the oldest excess rows, avoiding both a
  retained-window index scan and shared counter locks on event writers.
- Dependency-free `PUSHB` validation no longer builds three full compatibility
  snapshot views, and dashboard queue summaries aggregate job states in one
  snapshot pass instead of once per queue.
- PostgreSQL schema version 21 adds event-retention state, transaction-private
  deltas, and guarded statement-level insert/delete triggers. Its schema guard
  now distinguishes real immediate primary keys from same-name unique indexes
  and atomically rebuilds malformed derived retention state. Upgrade every
  broker in a cluster together; memory and SQLite schemas and behavior are unchanged.

## CI/CD

- Add standalone Windows arm64 and Linux musl x64/arm64 release binaries,
  completing the eight primary Bun targets. Require all eight compressed assets
  before publishing the release and include their SHA-256 checksums.
- Publish release images to Docker Hub at `egeominotti/bunqueue` alongside
  GHCR, with matching version, latest, and variant tags for amd64 and arm64.
- Update the README and installation/deployment guides with Docker Hub commands,
  the eight standalone downloads, and runtime and persistence requirements.
- Pin Bun to 1.4.2 across CI, SDK workflows, release images, and disposable test
  images; align deployment examples and the release-gate regression check.

## Documentation

- Redesigned the homepage around the free MIT-licensed server, supported client
  runtimes, and separate server/embedded setup paths with explicit connection
  addresses. Introduction and installation now explain why the engine uses Bun
  while network clients keep their own runtime.
- Refreshed documentation typography, sidebar and table-of-contents contrast,
  breadcrumbs, Markdown source links, responsive headers and mobile spacing.
  Wide tables now preserve their semantics inside keyboard-scrollable regions.
- Fixed custom-hero skip-link targets and the homepage's duplicate H1, while
  keeping existing documentation routes, tab synchronization and search.
- Added payload types to the Deno and embedded homepage examples, with a
  regression that compiles the published TypeScript snippets against both APIs.
  The Deno command now grants the worker's required hostname permission, and
  JavaScript/TypeScript workers log connection errors.
- Corrected the SDK guide's protocol description: v3 keeps job names separate
  from user payloads, including scalar, array and null payloads.
- Fixed a hosting rule that blocked the current API reference from indexing.
  Current API pages now receive canonical URLs and distinct metadata and are
  included in the sitemap; historical versions remain excluded. Social metadata
  and the homepage cover now reflect the free server and supported client runtimes.
- Added a dedicated [bunqueue 2.9.4 performance comparison](/guide/version-performance-2-9-4/)
  with a native, integrity-checked 11-version Embedded and TCP SQLite lifecycle campaign,
  methodology, resource results, interpretation guidance, and explicit limitations.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.4](/blog/bunqueue-v2-9-4/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.5) · [Commits since v2.9.4](https://github.com/egeominotti/bunqueue/compare/v2.9.4...v2.9.5) · [Full changelog](/changelog/) · [All posts](/blog/)
