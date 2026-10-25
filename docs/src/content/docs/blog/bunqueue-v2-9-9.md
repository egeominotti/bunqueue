---
title: "bunqueue v2.9.9"
description: "Fixes 3 bugs. Waiting for a job settles on its final outcome, for every Job and in both modes."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-9.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-03"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.9</em></h1>
  <p class="bq-hero-sub">Fixes 3 bugs. Waiting for a job settles on its final outcome, for every Job and in both modes.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.9.9

```bash title="bun"
bun add bunqueue@2.9.9
```

```bash title="npm"
npm install bunqueue@2.9.9
```

```bash title="docker"
TAG=2.9.9
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Bugfixes

- **Waiting for a job settles on its final outcome, for every Job and in both
  modes.** `Queue.waitJobUntilFinished()` and `job.waitUntilFinished()`
  rejected with the first attempt's error as soon as a job with retries left
  failed once, even when a later attempt completed. A wait now resolves with
  the result once the job completes and rejects with the last attempt's error
  once no retry is left, including a job the stall detector moves to the DLQ,
  and rejects with `Job <id> not found` once the job no longer exists
  (removed, drained, obliterated, or removed on completion before the wait saw
  it). `QueueEvents` still fires `failed` for every attempt and now marks it
  `terminal` (`false` while a retry is pending).
- **TCP waits without `QueueEvents` report failures and survive long TTLs.** A
  job that already failed settles at once; one that fails later is reported
  by the next state read (about 1 s after the start, then every 2 to 30 s,
  ±25%, while at most about 600 waits share a connection pool; less often
  beyond that) instead of at the TTL. `WaitJob` holds run under their own
  command timeout, so `commandTimeout` no longer cuts a wait short, and TTLs
  above 600000 ms are honoured (up to about 24.8 days, the runtime's timer
  limit). Holds are capped at 40 per connection (160 on a
  default pool of 4), so other commands keep broker slots: with a TTL at or
  above `commandTimeout` and jobs still pending, 120 waits on one connection
  used to fail with `Connection lost` after about 30 s. Beyond those slots a
  wait queues for one and can see a completion seconds late (1,000 concurrent
  waits on 1 s jobs: p90 2 s, where every wait used to see it at once), so use
  `QueueEvents` for high-concurrency request/response. `TcpConnectionPool`
  gains per-command timeouts (`send(command, { timeout })`) and per-connection
  long-poll leases (`reserveLongPoll(perConnection)`).
- **Waits no longer hang, and they no longer starve other traffic.** A wait
  with `QueueEvents` re-reads the job on `stalled`, `removed` and after a
  reconnect, carries on when the `QueueEvents` closes, and re-reads as a
  jittered safety net. Background reads share a budget of 20 per second per
  connection pool, and rate-limit refusals, command timeouts and lost
  connections are retried instead of rejecting the wait. After a broker outage
  a wait settles once the client has reconnected, which can lag by the
  reconnect backoff (up to 30 s) plus the next state read. The TTL is a timer
  of its own. Embedded waits share one manager subscription, never start a new
  engine after `shutdownManager()`, and reject with `waitUntilFinished: the
  embedded engine was shut down` when it stops. A TTL of `0` means no timeout
  with or without `QueueEvents`; an embedded `queue.add()` job accepts `null`
  instead of `QueueEvents`; a refused state read rejects with the broker's
  error; a job without a connection rejects instead of resolving `undefined`;
  and TCP `Job` objects now listen to the `QueueEvents` they are given. One
  implementation (`src/client/jobWait.ts`, `src/client/job-wait/`) replaces six
  copies that had drifted apart. The fix ships in `bunqueue-client` 0.2.2.

## Documentation

- **New diagrams in the MCP guide.** "Where the queue lives" now reads left to
  right: your AI client, the stdio or Streamable HTTP link, `bunqueue-mcp`
  with its optional features, and a fork to the embedded and TCP modes with
  what each keeps. The HTTP handler diagram shows a job in four numbered
  steps, from added to completed or failed, in the job-state colors the
  homepage uses, and states which methods send a body. Both follow dark and
  light mode and stack vertically on phones. The guide now says that GET and
  DELETE handlers send no body.
- **The queue simulator looks like itself again.** The refreshed heading,
  link, inline-code and table styles had reached inside the simulator,
  turning its lane and panel titles into large page headings. Those theme
  rules now skip widgets and diagrams marked `.not-content`, as Starlight's
  own styles do, and a test keeps it that way.
- **Every docs graphic in one visual language.** The simulator, the Web
  Dashboard architecture diagram and the three explainers on the Examples page
  now share the MCP diagrams' style: hairline panels on the docs color tokens,
  sentence-case labels instead of uppercase tags, monospace only for ids, ports
  and code, brand pink only for the subject or the active choice, and one
  job-state palette for every state they show (waiting gray, delayed indigo,
  retry amber, active pink, completed teal, failed rose). Each one follows its
  own width, so it no longer cramps next to the sidebar and stacks cleanly on
  phones without scrolling the page sideways.
- **Simulator.** Lanes, chips, counters, the event log and the shard map use
  that palette; chips show the id, job name and queue on separate lines;
  sliders announce their units; speed and queue choices expose their pressed
  state and the last scenario run is marked current; counts are spelled out
  next to every color; and reduced motion turns off its animations. Its
  behavior is unchanged.
- **Web Dashboard diagram.** It now draws two separate links to the server,
  `HTTP :6790` from the UI server's `/api/*` proxy and `TCP :6789` from the
  control agent's SDK bridges, shows the UI server bridging `/agent/*` to the
  agent and the optional Copilot calling the AI provider directly. The guide
  also corrects how long tokens last: they are kept in memory only, so
  reloading the page clears them.
- **Examples page.** The learning path is a compact numbered rail of clickable
  rows. The job lifecycle explorer shows every step with the state bunqueue
  reports, marks the attempts that throw with "✕ fails", and explains the
  current step in a card that screen readers announce. The topology explorer
  draws each layer as a zone joined by labelled links, with a one-line summary
  and the durability owner. All three lay themselves out by their own width,
  so they stack before a label or node name would have to wrap mid-word, and
  both explorers keep the same height whichever option is chosen and work
  fully from the keyboard.
- **AI agents on the homepage.** A new section below the Academy presents the
  MCP server's opt-in features (toolsets, confirmation of destructive calls,
  decision models) with the setup command, an example confirmation and the
  supported decision models (Jev, Clef, Clef-flash, Kev 9B, Laya,
  DiffusionGemma Jev); a second "New" announcement in the hero links to it.
- **MCP guide rewritten for first-time readers.** It now starts with a
  three-step setup with tabs per client, then explains where the queue lives,
  HTTP handlers and the optional features, with the HTTP server, workflow
  approvals, the parameter details and the environment variables after them.
  Every anchor that other pages link to is kept.
- **A first job in about a minute, the same everywhere.** The Quick Start now
  opens with three numbered steps for each path (start the server or install
  bunqueue, save the file and run it, see the expected output) in Node.js, Bun,
  Deno, Python, PHP, Go, Rust, Elixir and embedded Bun, followed by a table of
  where to go next; the video follows the first job. The homepage quickstart,
  the Quick Start and the README now show the same files from one source,
  checked by `test/docs-homepage-snippets.test.ts`.
- **Simpler navigation.** The sidebar goes from 17 groups to 11, starting with
  the Quick Start: cron, the dead letter queue and flows share one group, a new
  AI Agents group holds the MCP server and the agent integrations, and blog
  posts are listed on the blog page. No URL changed. The header keeps Academy,
  AI Agents, Dashboard and Blog; "vs BullMQ", the simulator and `llms.txt` moved
  to the sidebar and the footer.
- **A refreshed look.** Page titles use the homepage's condensed typeface,
  code blocks use cleaner GitHub-style colors without the fake terminal
  window, inline code is neutral instead of pink, and notes, tips and warnings
  use one thin border in the colors of job states. The sidebar and the
  table of contents mark the current page with a thin pink rail.
- **Easier reading.** Guide paragraphs hold about 75 characters per line
  instead of about 100. On phones, tables become one card per row instead of
  scrolling sideways, and the page title starts higher.
- **Leaner site stylesheet.** `custom.css` loses about 1,500 lines of rules for
  components no page renders any more: earlier homepage designs with their
  syntax colors, hero grid and benchmark card, the first queue simulator's
  lanes, the step list, and the terminal, language, trust and vs-BullMQ cards.
  The main site stylesheet shrinks from 154 KB to 130 KB (26.4 KB to 22.8 KB
  gzipped) and no page looks any different.
- **TCP protocol reference in nine pages.** `/api/tcp/` keeps the wire format,
  connection, negotiation, pipelining, authentication, response format and
  limits, plus a command summary that links every command to its section. The
  command reference moved, unchanged, to eight pages under `/api/tcp/`: jobs,
  queries, control and limits, DLQ, cron, flows, monitoring, and workers and
  webhooks. Command and family anchors now live on those pages.
- **A professional README for `bunqueue-client`.** The npm page of the
  TypeScript client now opens with the standard SDK header, then the same
  tested quick start as the docs (start the server, save `jobs.mjs`, run it),
  waiting for a result with `QueueEvents`, a runtime support table (Node.js 20+,
  Bun 1.4+, Deno 2+, Cloudflare Workers), and notes on ESM-only loading,
  CommonJS bundling, embedded mode and Deno. The migration guide from 0.1.x
  keeps its anchor. `test/docs-homepage-snippets.test.ts` now also fails if this
  quick start drifts from the docs. npm shows it with `bunqueue-client` 0.2.2.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.8](/blog/bunqueue-v2-9-8/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.9) · [Commits since v2.9.8](https://github.com/egeominotti/bunqueue/compare/v2.9.8...v2.9.9) · [Full changelog](/changelog/) · [All posts](/blog/)
