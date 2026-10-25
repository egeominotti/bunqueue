---
title: "bunqueue v2.8.9"
description: "Ships 3 additions. Remote failure → the job fails locally (retry with backoff → local DLQ): persist the source queue to survive an uplink outage while its process or volume survives; retryDlq() re-enqueues when connectivity returns."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-9.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-06-10"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.9</em></h1>
  <p class="bq-hero-sub">Ships 3 additions. Remote failure → the job fails locally (retry with backoff → local DLQ): persist the source queue to survive an uplink outage while its process or volume survives; retryDlq() re-enqueues when connectivity returns.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.9

```bash title="bun"
bun add bunqueue@2.8.9
```

```bash title="npm"
npm install bunqueue@2.8.9
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

**`queue.forward()`**, built-in store-and-forward from a local (edge) queue
to a remote bunqueue server. The IoT/edge pattern as a one-liner:

```typescript
const fwd = localQueue.forward({
  to: { host: 'central.example.com', port: 6789, tls: true, token },
  queue: 'ingest', // optional remote name
});
```

**Prebuilt binaries**, every release now attaches self-contained executables
(no Bun install needed): `linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64` + `SHA256SUMS`. Built for edge gateways (Raspberry Pi 4/5,
ARM64 boxes): download, untar, run.

## More additions

- Remote failure → the job fails **locally** (retry with backoff → local DLQ):
  persist the source queue to survive an uplink outage while its process or
  volume survives; `retryDlq()` re-enqueues when connectivity returns.
- Deduped re-forwards: forwarded jobs carry the deterministic remote jobId
  `fwd:<queue>:<localId>`, deduped server-side within the custom-id retention
  window (bounded LRU; remote `removeOnComplete` evicts the entry, for strict
  exactly-once across long outages, dedupe downstream).
- Preserves job name, data and priority; optional `durable: true` for
  per-job fsync server-side; `forwarded`/`error` events.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.8](/blog/bunqueue-v2-8-8/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.9) · [Commits since v2.8.8](https://github.com/egeominotti/bunqueue/compare/v2.8.8...v2.8.9) · [Full changelog](/changelog/) · [All posts](/blog/)
