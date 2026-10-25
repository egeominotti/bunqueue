---
title: "bunqueue v1.9.3"
description: "Fixes 1 bug. Unix Socket Support."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v1-9-3.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-01-31"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v1.9.3</em></h1>
  <p class="bq-hero-sub">Fixes 1 bug. Unix Socket Support.</p>
</div>

#### To install bunqueue v1.9.3

```bash title="bun"
bun add bunqueue@1.9.3
```

```bash title="npm"
npm install bunqueue@1.9.3
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Unix Socket Support

TCP and HTTP servers can now bind to Unix sockets
- Configure via `TCP_SOCKET_PATH` and `HTTP_SOCKET_PATH` environment variables
- CLI flags `--tcp-socket` and `--http-socket`
- Lower latency for local connections

## More additions

- Socket status line in startup banner

## Bugfixes

- Test alignment for shard drain return type

---

[← bunqueue v1.9.2](/blog/bunqueue-v1-9-2/) · [Full changelog](/changelog/) · [All posts](/blog/)
