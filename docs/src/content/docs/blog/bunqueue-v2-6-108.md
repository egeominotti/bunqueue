---
title: "bunqueue v2.6.108"
description: "bunqueue.config.ts, Global configuration file, defineConfig() helper, --config / -c CLI flag, cloudAgent.createFromConfig() and more."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-108.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-04-02"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.108</em></h1>
  <p class="bq-hero-sub">bunqueue.config.ts, Global configuration file, defineConfig() helper, --config / -c CLI flag, cloudAgent.createFromConfig() and more.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.6.108

```bash title="bun"
bun add bunqueue@2.6.108
```

```bash title="npm"
npm install bunqueue@2.6.108
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## `bunqueue.config.ts`, Global configuration file

Centralize all server configuration in a single typed file, similar to `vite.config.ts` or `drizzle.config.ts`. Auto-discovered from project root, supports `bunqueue.config.{ts,js,mjs}`. Priority: CLI flags > config file > env vars > defaults. Zero breaking changes, env vars continue to work as fallback.

## `defineConfig()` helper

Exported from both `bunqueue` and `bunqueue/client` for full TypeScript IntelliSense.

## `--config` / `-c` CLI flag

`bunqueue start --config ./custom.config.ts` to specify an explicit config file path.

## `CloudAgent.createFromConfig()`

Static factory method that accepts a pre-resolved `CloudConfig`, used by the config file flow.

## New docs page

`/guide/configuration/` with full reference, examples for development, production, and Docker/Kubernetes.

## Updated 17 docs pages

All documentation now references `bunqueue.config.ts` as the recommended configuration approach.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.6.107](/blog/bunqueue-v2-6-107/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.6.108) · [Commits since v2.6.107](https://github.com/egeominotti/bunqueue/compare/v2.6.107...v2.6.108) · [Full changelog](/changelog/) · [All posts](/blog/)
