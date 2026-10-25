---
title: "bunqueue v2.8.27"
description: "A security + correctness release."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-27.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-07-08"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.27</em></h1>
  <p class="bq-hero-sub">A security + correctness release.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

A security + correctness release. Two TLS fixes reported against 2.8.20 & 2.8.26 (thanks @assantech), plus a client-SDK parity fix. Each ships with a RED→GREEN reproduction test.

#### To install bunqueue v2.8.27

```bash title="bun"
bun add bunqueue@2.8.27
```

```bash title="npm"
npm install bunqueue@2.8.27
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Security

With native TLS enabled, Bun can deliver a socket `data` event before `open` has run (near-deterministic when a Worker boots its connections concurrently). The TCP `data` handler destructured `socket.data`, still null at that point, and the `TypeError` escalated to the process-level unhandledRejection handler, shutting the entire server down. Because the crash happens before authentication, any client that could reach an exposed TLS port could take the broker down (pre-auth remote DoS). Fix: per-socket state is now initialised lazily and idempotently from both `open` and `data` (`initConnection`), preserving that first frame; `close`/`drain` tolerate an uninitialised socket. Plaintext was never affected.

## Security

The TCP client's `tls` option was encryption-only: `Bun.connect` does not reject an unauthorized peer client-side, so every variant, including a **wrong pinned CA with `rejectUnauthorized: true`**, still connected. An active MITM could impersonate the broker and harvest the auth token. Fix: verification is enforced in a `handshake` handler using the `authorizationError` Bun computes. Verification is now the default for any TLS connection; only an explicit `rejectUnauthorized: false` opts out (encryption-only). A wrong/absent CA, a self-signed cert under system CAs, or `tls: true` against a self-signed server now reject with `TLS verification failed`. Two implementation details: the pinned CA is read into bytes (not a `Bun.file` handle) so Bun verifies against it, and every TLS connection resolves on `handshake` rather than `open` (registering a `handshake` handler makes Bun fire `open` before the handshake completes).

## Bugfixes

`JobOptions.backoff` is typed `number | { type: 'fixed' | 'exponential'; delay }`, and embedded mode has always accepted both forms, but the TCP `PUSH` validator only allowed a plain number, so `queue.add(name, data, { backoff: { type: 'exponential', delay: 200 } })` failed over the wire with `backoff must be a number`. The server now validates and accepts the object form (`type` must be `fixed`/`exponential`, `delay` bounded like the numeric form), restoring embedded/TCP parity. Reported against the client SDKs; RED→GREEN reproduction test included.

Also tightened the `PUSH` wire command type: `repeat` was under-declared (`every`/`limit`/`count` only) while the server consumes the full `JobInput['repeat']` shape (`pattern`, `tz`, `startDate`, `endDate`, …), typing-only, no runtime change.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.26](/blog/bunqueue-v2-8-26/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.27) · [Commits since v2.8.26](https://github.com/egeominotti/bunqueue/compare/v2.8.26...v2.8.27) · [Full changelog](/changelog/) · [All posts](/blog/)
