---
title: "bunqueue v2.6.60"
description: "Fixes 2 bugs. Webhook SSRF prevention in embedded mode: WebhookManager.add() now validates URLs against SSRF (localhost, private IPs, cloud metadata)."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-6-60.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-03-21"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.6.60</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Webhook SSRF prevention in embedded mode: WebhookManager.add() now validates URLs against SSRF (localhost, private IPs, cloud metadata).</p>
</div>

#### To install bunqueue v2.6.60

```bash title="bun"
bun add bunqueue@2.6.60
```

```bash title="npm"
npm install bunqueue@2.6.60
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Changes

- **Extracted `validateWebhookUrl` to shared module**: `src/shared/webhookValidation.ts` is now the single source of truth, re-exported from `protocol.ts` for backward compatibility.

## Bugfixes

- **Webhook SSRF prevention in embedded mode**: `WebhookManager.add()` now validates URLs against SSRF (localhost, private IPs, cloud metadata). Previously only enforced at TCP server layer, leaving embedded SDK unprotected.
- **Docs: pin Zod v3 for Starlight**: Fixed Vercel build crash caused by Zod v4 incompatibility with Starlight 0.31.

---

[← bunqueue v2.6.49](/blog/bunqueue-v2-6-49/) · [Full changelog](/changelog/) · [All posts](/blog/)
