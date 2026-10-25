---
title: "bunqueue v2.9.20"
description: "More TCP worker processes no longer slow the server down: draining a backlog with four worker processes is 2.9x faster and with eight 4x faster. Plus docs that AI agents read as plain Markdown, two RSS feeds and a refreshed site."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-20.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-25"
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.20</em></h1>
  <p class="bq-hero-sub">More TCP worker processes no longer slow the server down: draining a backlog with four worker processes is 2.9x faster and with eight 4x faster. Plus docs that AI agents read as plain Markdown, two RSS feeds and a refreshed site.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a class="bq-release-author" href="https://github.com/egeominotti">egeominotti</a></p>

Adding workers should make a queue faster. With bunqueue's TCP server it did the
opposite: one worker process drained about 33,000 jobs per second, four drained
18,000 and eight about 10,000. This release fixes that, without changing what
the server sends or in which order.

#### To install bunqueue v2.9.20

```bash title="bun"
bun add bunqueue@2.9.20
```

```bash title="npm"
npm install bunqueue@2.9.20
```

```bash title="docker"
TAG=2.9.20
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## More worker processes, more throughput

Every TCP Worker subscribes to its queue's events, so it can report `stalled`
jobs. A pull or an acknowledgement of a batch of jobs emits one event per job,
and the server wrote each event to each subscribed worker with its own socket
write. With four worker processes, about 64% of the server's CPU went into those
writes, and every extra process added more of them per job.

The server now writes a batch's events to each subscriber in one call: the same
frames, in the same order, encoded once. Draining a backlog over TCP, with 50
concurrent jobs per worker process:

| Worker processes | v2.9.19 | v2.9.20 | Change |
| --- | --- | --- | --- |
| 1 | 33,080 jobs/s | 39,735 jobs/s | 1.2x |
| 4 | 18,152 jobs/s | 53,102 jobs/s | 2.9x |
| 8 | 10,151 jobs/s | 40,940 jobs/s | 4.0x |

A connection whose write queue goes over its budget is still closed at the same
point, single events are written as before, and an event that cannot be encoded
is still skipped alone. The PostgreSQL backend broadcasts events one at a time
and is unchanged.

## How it was found

The regression surfaced while building a reproducible comparison against BullMQ
6.4.2 on Redis 8.10.2: with one worker process the two were level, and with more
processes BullMQ stayed flat while bunqueue fell. A CPU profile of the server
during a four-process drain put 63.5% of its time in native socket writes called
from the event bridge, and almost none in the queue itself.

## Docs that AI agents can read

`/llms-full.txt` and the Markdown version of every page (`/guide/queue.md` and so
on) used to carry the MDX source of the site. They are now plain Markdown: tabs
become bold labels above each language's code, callouts become blockquotes, and
links are absolute. Outside code blocks, `llms-full.txt` alone dropped:

| In `llms-full.txt`, outside code | Before | Now |
| --- | --- | --- |
| `<div>` | 957 | 0 |
| `class` attributes | 1,448 | 0 |
| `import` lines | 97 | 0 |
| `<Tabs>`/`<TabItem>` tags | 2,272 | 0 |
| Code fence lines | 3,312 | 3,312 |

`llms.txt` now lists all 114 documentation pages instead of 62, and its quick
example creates the worker with `embedded: true`: without it the worker connected
over TCP and never saw the embedded queue's jobs.

## Release notes on the blog, with RSS

Every release has a post like this one, the blog index shows the latest post
first with Everything, Articles and Releases filters, and two RSS feeds follow
it: [every post](/rss.xml) and [releases only](/blog/releases.xml).

## A refreshed site

The documentation and the homepage share one typeface for titles and text, with
a calmer type scale, code in IBM Plex Mono everywhere and quieter copy buttons
and heading links. On phones, prose, headings, code and callouts now share one
margin. The homepage also had the MCP tool count wrong: the server has 79 primary
tools in 11 toolsets, not 75.

## Other improvements

- Pull requests that only touch the site, Markdown files or `.claude/` skip the
  product test suites and run the docs build and the tests that read the docs.
- GitHub releases are titled `bunqueue vX.Y.Z` and link to their blog post.

## How these numbers were measured

Native Linux (Debian 13, AMD Ryzen 9 7950X3D, Bun 1.4.4), memory mode, server
pinned to two physical cores, worker processes on the other core complex,
`pollTimeout: 5000`, median of three runs per row.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.19](/blog/bunqueue-v2-9-19/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.20) · [Commits since v2.9.19](https://github.com/egeominotti/bunqueue/compare/v2.9.19...v2.9.20) · [Full changelog](/changelog/) · [All posts](/blog/)
