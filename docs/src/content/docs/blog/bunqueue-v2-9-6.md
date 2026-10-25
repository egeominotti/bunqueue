---
title: "bunqueue v2.9.6"
description: "Fixes 2 bugs. Unhandled rejections are reported again after a TCP client close."
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/blog/bunqueue-v2-9-6.png
  - tag: meta
    attrs:
      property: og:type
      content: article
  - tag: meta
    attrs:
      property: article:published_time
      content: "2026-10-01"
---

<!-- Generated from changelog.md by docs/scripts/generate-release-posts.ts. Edit the changelog and regenerate. -->

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">blog · release</span>
  <h1 class="bq-hero-h1 bq-bench-h1">bunqueue <em>v2.9.6</em></h1>
  <p class="bq-hero-sub">Fixes 2 bugs. Unhandled rejections are reported again after a TCP client close.</p>
</div>

<p class="bq-release-byline"><img src="https://github.com/egeominotti.png?size=64" alt="" width="28" height="28" loading="lazy" /> <a href="https://github.com/egeominotti">egeominotti</a></p>

#### To install bunqueue v2.9.6

```bash title="bun"
bun add bunqueue@2.9.6
```

```bash title="npm"
npm install bunqueue@2.9.6
```

```bash title="docker"
TAG=2.9.6
docker run -p 6789:6789 -p 6790:6790 ghcr.io/egeominotti/bunqueue:$TAG
```

#### To upgrade bunqueue

```bash
bun add bunqueue@latest
```

## Behavior changes

- **Unhandled rejections are reported again after a TCP client close.**
  Applications that relied, knowingly or not, on bunqueue hiding their
  unhandled rejections now exit with code 1 after a client `close()`, as Bun
  and Node do by default. Handle the rejection, or register your own
  `process.on('unhandledRejection', ...)` listener if you want to keep running;
  bunqueue defers to it. Details under Client fixes below.
- **Flat connection options are rejected.** `Queue`, `Worker`,
  `FlowProducer`, `QueueEvents`, `Bunqueue`, `SandboxedWorker`,
  `QueueGroup.getQueue()/getWorker()`, and the workflow `Engine` now throw when TCP-mode options carry top-level `host`, `port`,
  `token`, or `tls`. Those keys were never read, so the client silently
  connected to `localhost:6789` without the intended token or TLS. Pass them
  as `connection: { host, port, token, tls }`. Embedded mode is unaffected.
  Regression: `test/legacy-connection-options.test.ts`.

## TypeScript SDK (bunqueue-client 0.2.0)

- **Breaking minor release.** The default `bunqueue-client` entry is the
  canonical `bunqueue/client` API, and the 0.1.x API stays unchanged at
  `bunqueue-client/legacy`. The unreleased version moved from 0.1.10 to 0.2.0
  so `^0.1.9` ranges do not pick up the new API. In TCP mode, `pause()`,
  `drain()`, `obliterate()` and the other synchronous control calls do not
  wait for the broker, and synchronous reads return defaults; use the `*Async`
  variants. See the migration guide in `sdk/typescript/README.md#migrating-from-01x`.
- Queued commands no longer fail with "Connection lost" when the broker starts
  after the client under Node, Deno, or Workers. The portable transport now
  reports a close only for connections that actually opened, as the Bun
  transport does. Regression: `test/tcp-parity-late-broker.test.ts`.
- The package bundles as CommonJS again: the embedded engine loads lazily and
  synchronously under Bun instead of through a top-level `await`. Regression:
  `test/client-parity-cjs-bundle.test.ts`.
- Published declarations no longer reference `bun-types` or leak Bun globals,
  and the package depends only on `msgpackr`. The build fails unless the
  declarations type-check for a strict NodeNext consumer with
  `@types/node` 20 or 22 and `skipLibCheck: false`.
- The TLS, security, databases and examples guides and the README now pass
  bunqueue-client settings through `connection`.

## PostgreSQL

- **Storage health recovers after a dropped projection-refresh retry.** Lease
  renewals and batched completions that apply a job's committed state, local
  claims, and authoritative queue refreshes now clear that job's
  `projection-refresh` health error, and a failed `getJob`/`getJobState` read
  queues a background retry. Previously `/health` and `/ready` could report 503
  until the job's next event, or forever for a finished job. Regressions:
  `test/repro-postgres-direct-projection-clears-health.test.ts` and
  `test/postgres-projection-health-recovery.test.ts`.

## Client fixes

- **Unhandled rejections are no longer swallowed after a TCP client close.**
  `TcpClient.close()` installed a process-wide `unhandledRejection` listener
  that ignored every reason except `ClientClosedError`. Because any listener
  disables the Bun/Node default (print the error and exit 1), every unhandled
  rejection in the host application disappeared after the first close, with
  exit code 0. The filter still swallows synthetic `ClientClosedError`
  rejections, defers to application-owned listeners, and otherwise removes
  itself and re-raises the reason so the runtime's configured mode applies.
  Global `Symbol.for` brands let duplicate bunqueue copies in one process share
  one filter, and a foreign error that is merely named `ClientClosedError` is no
  longer treated as bunqueue's. Regression:
  `test/repro-client-closed-filter-swallows-app-rejections.test.ts`.
- **A TCP Worker with `limiter.groupKey` no longer FAILs a job that succeeded.**
  A buffered job whose group value cannot be converted to a string (for
  example `{ toString: 'x' }` from JSON or msgpack) made the dynamic ACK
  threshold throw after the ACK was queued. The successful job was then
  retried, a false `failed` event was emitted, and the stranded ACK was sent
  later with a stale token. The `concurrency` setter could throw for the same
  reason. Group-value extraction now never throws, keeps existing keys and
  falls back to a deterministic tag. If the dynamic ACK ceiling throws, the
  batcher uses the static `batchSize`, keeps the ACK, and reports an `error`
  event with `context: 'ack-threshold'`. Regression:
  `test/repro-worker-group-value-poison-ack.test.ts`.

## CI/CD

- **Every published artifact of a run comes from one verified source commit.**
  The 2.9.5 npm package and Docker images were built from main commits later
  than the `v2.9.5` tag (105b8794): manual Docker rebuilds and npm publications
  checked out main. The version gate now outputs `source_sha`. It is the pushed
  commit for a new version, or the existing tag's commit for a rebuild or npm
  publication, and the gate fails when that commit's `package.json` disagrees.
  Binaries, images, the npm tarball, and the GitHub release (`target_commitish`)
  all use that commit. A rebuild fails on trees without the Docker variant
  inputs, so v2.9.5 itself cannot be rebuilt by this workflow. Images carry
  verified `org.opencontainers.image.revision` and `version` labels.
- **The TypeScript SDK release can authenticate.** `sdk-release.yml` passed the
  token as `NODE_AUTH_TOKEN`, which Bun ignores. It now uses `NPM_CONFIG_TOKEN`,
  runs `bun pm whoami` and a dry run of the packed tarball, and then publishes
  that same tarball. The tag and registry gates fail closed. The `--provenance`
  flag and `id-token: write` permission were removed because Bun produces no
  provenance.
- **Every third-party GitHub Action is pinned to a full commit SHA**, with a
  comment naming its release, in all workflows.

## Documentation

- Redesign the homepage. The hero leads with adding a job in one language and
  processing it in another, shown by a simulated queue whose jobs move through
  waiting, delayed, active, retry and completed (static when reduced motion is
  requested). Capabilities follow the job lifecycle with matching state
  colors, storage reads as a path from memory to SQLite to PostgreSQL, and
  headings use condensed Bricolage Grotesque. The quickstart content is
  unchanged.
- List public open-source projects that use bunqueue directly below the hero
  (context-labs/HALO, MagicCube/agentara, dosco/aithy and phuctm97/openkitten)
  with their GitHub star counts and a link to GitHub's dependents graph.
- The hero simulation has a Pause button, stops when reduced motion is turned
  on while the page is open, and is excluded from search snippets.
- Search metadata: the homepage H1 names background jobs again and its meta
  description fits search results. Fifteen descriptions longer than 160
  characters were shortened, 19 titles no longer repeat "bunqueue" in the
  suffix, URLs without a trailing slash redirect with 308 to the canonical
  page, current API reference pages gain a social image, and the changelog
  outline lists releases only.
- Add a [Web Dashboard guide](/guide/dashboard/) for the open-source
  [bunqueue dashboard](https://github.com/egeominotti/bunqueue-dashboard):
  quick start, capabilities, a connection diagram, the actions that fail
  closed, deployment options, configuration variables, the security model for
  network access, and the experimental AI Copilot's data handling. The
  homepage introduces the dashboard directly below the hero with a screenshot,
  the `bunx bunqueue-dashboard` command and links to the guide, the live demo
  and the repository. "Dashboard" is the first link in the header and mobile
  menu, and the sidebar lists the guide under Run in Production.
- Audit the guide, API and architecture pages against the source and fix every
  error that could be verified. Examples that did not compile or run now do:
  Go `job.Data()` indexing without a type assertion, Go `worker.Run()` used as
  if it returned an error, untyped TypeScript job data, the Python minimal
  worker exiting before it processed a job, and Node.js DLQ calls that return
  nothing over TCP (`getDlqAsync`, `purgeDlqAsync`, `setDlqConfigAsync`).
  Retry delays in examples and the HTTP reference now follow the real formula
  (the first retry waits about twice the base `backoff`, with jitter, capped
  at one hour). The HTTP and TCP references gain the real webhook
  event names, named SSE events, `/count` and Cancel semantics, the
  10,000-entry results cache, `/health` returning 503 when storage is
  degraded, bulk push keeping jobs accepted before a runtime admission error,
  and the missing `PUSHF`, `SubscribeEvents` and `UnsubscribeEvents` commands.
  Two security notes are corrected: a WebSocket connection must send its token
  in the upgrade request's header, because the server refuses the upgrade
  without it (an `Auth` message after connecting never gets that far), and S3
  backups rely on the bucket's default encryption because bunqueue has no
  encryption option of its own. Type and architecture pages now match the
  exports, the 38-column `jobs` table and six model campaigns;
  `BUNQUEUE_EMBEDDED` is documented as a default rather than an override; the
  Compose example uses the published image and its `/app/data` volume; and the
  binary install downloads the published archive.

## Thanks to 1 contributor!

- [@egeominotti](https://github.com/egeominotti)

---

[← bunqueue v2.9.5](/blog/bunqueue-v2-9-5/) · [Release on GitHub](https://github.com/egeominotti/bunqueue/releases/tag/v2.9.6) · [Commits since v2.9.5](https://github.com/egeominotti/bunqueue/compare/v2.9.5...v2.9.6) · [Full changelog](/changelog/) · [All posts](/blog/)
