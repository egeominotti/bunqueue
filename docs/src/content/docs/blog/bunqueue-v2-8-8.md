---
title: "bunqueue v2.8.8"
description: "Server, fail fast, client SDK, CLI client."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-8-8.png
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
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.8.8</em></h1>
  <p class="bq-hero-sub">Server, fail fast, client SDK, CLI client.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.8.8

```bash title="bun"
bun add bunqueue@2.8.8
```

```bash title="npm"
npm install bunqueue@2.8.8
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## What's new

**Native TLS termination**, no reverse proxy needed. Opt-in and fully
backward compatible: without cert/key config, both servers behave exactly as
before (plaintext).

**MQTT → bunqueue bridge example** (`examples/mqtt-bridge/`), IoT/edge
recipe: MQTT messages become persisted jobs with retries, DLQ and offline
buffering on an edge gateway (embedded SQLite queue), with optional TLS
forwarding to a central server.

## Server

`bunqueue start --tls-cert ./cert.pem --tls-key ./key.pem`, or
`TLS_CERT_FILE`/`TLS_KEY_FILE` env vars, or `server.tlsCertFile`/`tlsKeyFile`
in `bunqueue.config.ts`. One cert pair covers the TCP server (msgpack
protocol, unchanged) and the HTTP server (`https://`/`wss://`).

## Fail fast

Missing cert/key file or a partial config (cert without key)
is a startup error, the server never silently falls back to plaintext.

## Client SDK

`connection.tls` on `Queue`/`Worker`, `true` (system CAs),
`{ caFile }` (private CA / self-signed with full verification), or
`{ rejectUnauthorized: false }` (dev only). TLS and plaintext pools to the
same host:port are never shared.

## CLI client

`--tls`, `--tls-ca <file>`, `--tls-no-verify` global flags.

## More additions

- Pooled TCP clients no longer crash the process on socket-level errors
  (e.g. a plaintext client hitting a TLS server): the error is observed and
  pending commands settle through the close/timeout paths.
- New guide: [Native TLS](/guide/tls/).

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.8.7](/blog/bunqueue-v2-8-7/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.8.8) · [Commits since v2.8.7](https://github.com/egeominotti/bunqueue/compare/v2.8.7...v2.8.8) · [Full changelog](/changelog/) · [All posts](/blog/)
