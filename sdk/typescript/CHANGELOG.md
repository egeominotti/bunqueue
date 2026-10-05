# Changelog

All notable changes to `bunqueue-client` (TypeScript SDK) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2026-10-05

Bun and Node.js run a timer whose delay is `NaN`, negative or above 2^31 - 1 ms
(about 24.8 days) after about 1 ms. Durations reached timers from options
without validation, so a typo became a hot loop, a spurious timeout or a stuck
job. Both entries now validate durations and counts where they enter, and arm
every timer through the shared helpers, which honour any delay.

### Security

- Default entry: shared TCP pools and clients are keyed by every connection
  option and the full 64-bit hash of the token (never the token itself). The
  previous key used a 16-bit token fingerprint (about 1,900 distinct values),
  so two callers with different auth tokens could share a pool, and the second
  caller's commands ran authenticated as the first. Callers with equal options
  still share a pool; callers with different timeouts or ping and reconnect
  settings now get separate pools, so they open more connections.

### Fixed

Default entry (`bunqueue-client`, compiled from the bunqueue client):

- The portable `sleep` and the Node.js connect timeout honour durations above
  about 24.8 days. Before, they fired after about 1 ms.
- `job.waitUntilFinished()` and `Queue.waitJobUntilFinished()` TTLs above
  about 24.8 days hold for the whole TTL. Before, the wait rejected with
  `timed out after <ttl>ms` within milliseconds. This is the bunqueue 2.9.10
  fix, which 0.2.2 did not include.
- Durations and counts are checked at construction, keeping every 0.2.2
  result that was not broken: a plain-digit string is its number
  (`port: process.env.PORT`), a fraction rounds as 0.2.2's comparisons did
  (`concurrency: 2.5` runs 3), a negative or `NaN` interval that 0.2.2 guarded
  with `> 0` means disabled, an option the active mode does not use is not
  checked, and `undefined` and `null` mean the default. Values 0.2.2 could not
  run with (a hot loop, a ~1 ms timer, a lease that is already expired, a pull
  loop that never processes) throw a `TypeError` or `RangeError` naming the
  owner and the option, for example
  `Worker: heartbeatInterval must be a finite number of milliseconds >= 1 (got 0.5)`.
  The rules cover `ConnectionOptions` and pool options (`poolSize` up to
  65535), `Worker`, `SandboxedWorker`, `Queue` `autoBatch` and the `Bunqueue`
  Simple Mode options.
- In TCP mode a synchronous Queue method (`pause()`, `remove()`,
  `setDlqConfig()`, the rate-limit setters and the others) no longer ends the
  process when the broker is unreachable: the failure is logged as one line
  naming the command and the queue, or emitted on Simple Mode's `error` event
  while a listener is attached.
- A Worker whose pull is refused backs off (100 ms to 30 s) and retries,
  instead of idling as if the queue were empty. A permanent refusal (a bad
  token) goes to the `error` listener, or else to one `console.error` line a
  minute, and never ends the process.
- Connection races: `close()` during `connect()` wins, and the attempt closes
  its socket. A socket that hits the connect timeout is closed, and events
  from a stale socket no longer reach the current connection. `close()` inside
  a `'reconnecting'` listener no longer reconnects.

Legacy entry (`bunqueue-client/legacy`). Every timer that takes an option
value now honours delays beyond 24.8 days. Where an option accepts `Infinity`,
no timer is armed.

- A `heartbeatIntervalS` above about 24.8 days (2147484 s or more) sent a
  `Heartbeat` about every millisecond.
- A `commandTimeoutMs` or per-call `timeoutMs` beyond the limit timed out
  every command at once. After three timeouts this also forced a reconnect.
  `commandTimeoutMs: Infinity` now means no client-side deadline.
- A `connectTimeoutMs`, `ackBatch.maxDelayMs`, Simple Mode retry delay,
  `circuitBreaker.resetTimeout`, `batch.timeout`, `cancel()` grace period,
  `priorityAging.interval` or rate-limit window beyond the limit fired after
  about 1 ms. `circuitBreaker.resetTimeout: Infinity` now stays open until
  `resetCircuit()`.
- A Worker with `pollTimeoutMs: 0` re-polled an empty queue at once: 8,244
  `PULLB` per second against a local broker, until the broker's rate limiter
  cut it off. After an empty pull the Worker now pauses as the default entry
  does: 50 ms with `pollTimeoutMs: 0` (19 `PULLB`/s), 10 ms after a long poll.
- `maxInFlight: NaN` parked every command forever. `new ConnectionPool(NaN)`
  built a pool with no connection, and `new ConnectionPool(Infinity)` threw
  `Invalid array length`.
- A Worker `pollTimeoutMs` or `lockTtlMs` of `NaN` made every `PULLB` fail
  serialization. The Worker emitted `error` every 200 ms and never pulled a job.
  A negative `pollTimeoutMs` was sent to the broker, which rejected every pull.
  `queue.waitForJob(id, NaN)` failed with a generic `SerializationError`.
- Simple Mode retry backoffs saturate at `Number.MAX_SAFE_INTEGER` ms. Before,
  `exponential`, `jitter` and `fibonacci` overflowed to `Infinity` (a retry
  after about 1 ms), or to `NaN` with a zero base delay.
- Simple Mode: when `retry.customBackoff` returns `Infinity` or a value that
  is neither a number nor a numeric string, the job fails with a `RangeError`
  or `TypeError` whose `cause` is the processor error. Before, the job retried
  after about 1 ms. `NaN`, a negative number, `undefined` and `null` still
  retry at once, as in 0.2.2.
- `cancel()` and `close()` end a pending Simple Mode retry wait with
  `Job cancelled`.
- Simple Mode: a processor or middleware that throws synchronously, with or
  without `retry`, is handled like a rejection. Before, the circuit breaker did
  not count it, `retry` skipped the remaining attempts, and the job's
  cancellation registration was never released (one leaked entry per job). A
  throwing circuit-breaker hook (`onOpen`, `onClose`) no longer skips that
  release either. This mirrors the bunqueue client fix.
- Priority aging runs at most one tick at a time. A failed job scan is skipped
  instead of raising an unhandled rejection, which ends a Node.js process by
  default.
- The SDK clamps of `sdk/CLAUDE.md` rule 4 and the protocol spec hold
  for every number, and never throw for one.
  - `heartbeatIntervalS`: `0`, negative, `NaN`, `±Infinity` or a non-number
    disables heartbeats; any positive period is honoured.
  - `batchSize`: clamped to [1, 1000]; `NaN`, `±Infinity` or a non-number
    means 10.
  - `pollTimeoutMs`: clamped to [0, 30000]; `NaN` means 5000.
  - `waitForJob()` ttl: clamped to [0, 600000]; `NaN` means 30000.
  - `Bunqueue` `heartbeatInterval` and `pollTimeout` are forwarded under the
    same rules.
  The default entry has its own rules for these options; `LEGACY.md` lists
  the differences.
- Option values that 0.2.2 turned into a hot loop, a hang, a crash or a timer
  firing after about 1 ms now throw in the constructor, with a `TypeError` or
  `RangeError` that names the option, for example
  `Queue: commandTimeoutMs must be a finite number of milliseconds >= 1 or Infinity (got 0)`.
  Every other value keeps its 0.2.2 result. `LEGACY.md` ("Option validation")
  lists each option.
  - `Connection`, `Queue`, `ConnectionPool`: a `connectTimeoutMs` or
    `commandTimeoutMs` of 0, negative or `NaN` (every attempt or command timed
    out after about 1 ms), `connectTimeoutMs: Infinity`, `maxInFlight: NaN`,
    and a pool size of `NaN`, `Infinity` or above 65535.
  - `Worker`: a `concurrency` that is `NaN` or fractional (the pull loop sent
    invalid counts and emitted `error` every 200 ms) or `Infinity` (worker
    registration failed serialization), and a `lockTtlMs` that is `NaN`,
    below 1 or `Infinity`.
  - `Bunqueue`: a `priorityAging.interval` that is `NaN`, below 1 ms or
    `Infinity` (a 1 ms spin), `priorityAging.maxScan: Infinity`, a string
    `priorityAging.boost`, a rate limit `max` that is 0, negative, `NaN` or
    omitted (it waited forever on a 1 ms poll), and `duration: Infinity`.
  - `Infinity` where it does not mean "never": `ackBatch.maxDelayMs`,
    `retry.delay`, `batch.timeout` and the `cancel()` grace period.

### Changed

Behavior changes to check when upgrading the legacy entry. Every option value
that worked in 0.2.2 keeps its 0.2.2 result: a numeric string is read as its
number, a negative `maxInFlight` is unbounded, a fractional pool size is
floored, a `retry.maxAttempts` of 0 is one attempt, an unknown
`retry.strategy` is a fixed delay, and a `NaN` or negative one-shot delay runs
at once. Only the following change:

- The values listed under "Fixed" throw at construction instead of failing
  later.
- `concurrency` below 1 throws a `RangeError` (still an `Error`) whose message
  contains 0.2.2's `concurrency must be >= 1`, now prefixed with `Worker: ` and
  followed by the received value.
- A negative `pollTimeoutMs` clamps to 0, and a `NaN` one means 5000. Both used
  to fail every pull.
- A numeric string `lockTtlMs` or rate limit `duration` is read as its number.
  0.2.2 sent the string to the broker, or appended it to the wait and then
  polled every millisecond.
- A string that is not a number throws a `TypeError` where 0.2.2 fed it to a
  timer, for example `cancel(id, 'soon')`.
- Long durations are honoured. For example, a 30-day `resetTimeout` no longer
  half-opens after about 1 ms.

### Tests

- Seven deterministic `bun:test` files now run in `bun run test:property`.
  Five pin the fixes: `tests/legacy-connection-durations.test.ts`,
  `tests/legacy-worker-durations.test.ts`,
  `tests/legacy-simple-mode-durations.test.ts`,
  `tests/legacy-simple-mode-validation.test.ts` and
  `tests/legacy-simple-mode-sync-throw.test.ts`; 50 of their 59 cases fail
  against 0.2.2. Two pin 0.2.2 compatibility:
  `tests/legacy-compat-options.test.ts` and
  `tests/legacy-compat-simple-mode.test.ts`; all 39 cases pass against 0.2.2.
- `tests/e2e-durations.ts` and `tests/e2e-legacy-compat.ts`, registered in
  `tests/e2e.ts`, run the built package against a real broker on Bun, Node.js
  and Deno. All five `e2e-durations` cases failed before the fix (336
  heartbeats in about 600 ms on Bun, 333 on Node.js; 8,244 `PULLB`/s). All five
  `e2e-legacy-compat` cases pass against the 0.2.2 package and broker.

### Development

- `bun run typecheck`, part of `bun run check` (and so of CI), checks every
  source with the compiler options of the build's declaration emit
  (`tsconfig.json`). It also checks the legacy entry with NodeNext and only
  Node.js types (`tsconfig.legacy.json`), which enforces explicit `.js`
  imports and no `Bun` globals. Before, `tsc -p tsconfig.json` failed with 43
  `rootDir` and resolution errors.
- `connection.ts` and `queue-query.ts` are split (`connection-base.ts`,
  `queue-counts.ts`) to keep every source file within 250 lines. The public API
  is unchanged.

## [0.2.2] - 2026-10-03

### Added

- `TcpConnectionPool.send(command, { timeout })` accepts a per-command
  timeout, and `TcpConnectionPool.reserveLongPoll(perConnection)` leases
  long-poll slots per connection; both are optional and additive.
- `QueueEvents` `failed` payloads carry `terminal`: `false` for an attempt
  that will be retried, `true` once the job failed for good.

### Fixed

These fixes apply to the default entry (`bunqueue-client`);
`bunqueue-client/legacy` is unchanged.

- `Queue.waitJobUntilFinished()` and `job.waitUntilFinished()` settle on the
  job's final outcome. A failed attempt that will be retried no longer rejects
  the wait; a job that runs out of retries, or that the stall detector moves to
  the DLQ, rejects with the last attempt's error; a job that no longer exists
  rejects with `Job <id> not found`.
- Over TCP without `QueueEvents`, a failed job is reported by the next state
  read (1 s after the start, then every 2 to 30 s ±25%, while at most about 600
  waits share a pool) instead of at the TTL. Waits are no longer cut short by
  `commandTimeout`, and TTLs above 600000 ms are honoured (up to about 24.8
  days, the runtime's timer limit). At most 40 waits per connection hold
  `WaitJob`, so other commands keep broker slots; further waits queue and can
  see a completion seconds late, so use `QueueEvents` for high-concurrency
  request/response.
- Waits survive a `QueueEvents` `close()`, reconnects and broker outages:
  rate-limit refusals, timeouts and lost connections are retried within a
  per-pool read budget, and the wait settles once the client has reconnected
  (which can lag by the reconnect backoff, up to 30 s, plus the next state
  read) or at its TTL.
- Behavior changes to check when upgrading: embedded waits reject when
  `shutdownManager()` stops the engine (add a `.catch` to fire-and-forget
  waits) and never restart it; a `Job` without a connection rejects with
  `waitUntilFinished: no connection` instead of resolving `undefined`; TCP
  `Job` objects now listen to the `QueueEvents` they are given; an embedded
  `queue.add()` job accepts `null` instead of `QueueEvents`; a refused state
  read rejects with the broker's error; and a TTL of `0` means no timeout.

### Documentation

- README rewritten: standard SDK header, the same tested quick start as the
  bunqueue docs, waiting for a result with `QueueEvents`, a runtime support
  table, and notes on ESM-only loading, CommonJS bundling, embedded mode and
  Deno. The migration guide from 0.1.x keeps its anchor.

## [0.2.1] - 2026-10-02

### Fixed

- Ships the bunqueue 2.9.7 engine and client fixes this package compiles in
  (they apply to embedded mode and to the canonical Queue/Worker classes):
  periodic cleanup no longer drops active jobs that are still sending
  heartbeats or renewing their lock; orphan recovery goes through the stall
  path and releases the concurrency slot, group slot and unique key; recovery
  sweeps act only on the current delivery; `backoff.maxDelay` is kept on job
  creation and caps retry delays; `DelayedError` honors `backoff.maxDelay`,
  and TCP workers keep the backoff configuration the server sends.
- `BackoffOptions` accepts `maxDelay`, so `backoff: { type, delay, maxDelay }`
  type-checks.

## [0.2.0] - 2026-10-01

### BREAKING CHANGES

This is a breaking minor release. Follow the
[migration guide](./README.md#migrating-from-01x), or switch the import to
`bunqueue-client/legacy`, which keeps the 0.1.x API unchanged.

- The default `bunqueue-client` entry is now the canonical `bunqueue/client`
  API (see Changed below); the 0.1.x API moved to `bunqueue-client/legacy`.
- Connection settings must be passed as `connection: { host, port, token, tls }`.
  Top-level `host`, `port`, `token`, or `tls` now throw an `Error` naming the
  keys, in `Queue`, `Worker`, `FlowProducer`, `QueueEvents`, `Bunqueue`,
  `SandboxedWorker`, `QueueGroup.getQueue()/getWorker()`, and the workflow
  `Engine`, instead of silently connecting to `localhost:6789` without the
  token or TLS.
- In TCP mode `pause()`, `resume()`, `drain()`, `obliterate()`, `remove()`,
  and the synchronous rate-limit, concurrency, stall, and DLQ setters send
  their command without waiting for the broker. Await `pauseAsync()`,
  `resumeAsync()`, `drainAsync()`, `obliterateAsync()`, `removeAsync()`, and
  the other `*Async` variants before enqueuing follow-up work.
- Synchronous reads (`isPaused()`, `count()`, `getJobs()`, `getWaiting()` and
  the other state lists, `getCountsPerPriority()`, `getDlq()`, `getDlqStats()`,
  `getStallConfig()`, `getDlqConfig()`, `clean()`) are embedded-only and return
  defaults in TCP mode; use their `*Async` variants. `getJobCounts()` returns
  a `Promise` in TCP mode.
- `Job` is exported as a type only (`import type { Job }`); there is no `Job`
  constructor and no `job.raw`.
- Removed type exports: `BunqueueConnection`, `TlsOption`, `BackoffOptions`,
  `DeduplicationOptions`, `RepeatOptions`, `SchedulerOptions`, `FlowOptions`,
  `GetFlowOptions`, `BulkJobEntry`, `JobCounts`, `JobStateName`, `JobRaw`,
  `CircuitState`, `TelemetryErrorOperation`, `WorkerEventMap`,
  `AckBatchOptions`, `Command`, `Response`, and the `*Response` wire types.
  The migration guide lists each replacement.
- `AuthError`, `BunqueueError`, `CommandError`, `CommandTimeoutError`,
  `ConnectionClosedError`, and `SerializationError` remain exported for the
  low-level `Connection`/`ConnectionPool`, but `Queue`, `Worker`,
  `FlowProducer`, and `QueueEvents` reject with plain `Error` instances.
- `@types/node` is no longer installed with the package. The declarations
  import `events` and `node:net`, so TypeScript consumers must provide
  `@types/node` themselves (20 or newer), including Workers projects that
  type-check with `skipLibCheck: false`.
- After any client `close()`, an unhandled rejection in your application is
  no longer swallowed: without your own `unhandledRejection` handler the
  process reports it and exits with code 1, as Bun and Node do by default.

### Changed

- The default entry now uses the canonical Bun client implementation and
  public types. Queue/Worker/Job behavior, defaults, events, groups, batches,
  dependency helpers, and Async methods share one source across packages.
  Historical flat-option SDK APIs remain available at `bunqueue-client/legacy`.
- Builds reject stale source/artifact manifests and any public type/API drift.
  Shared native contracts and generated histories exercise the compiled SDK;
  Bun, Node 20/22, Deno, protocol conformance, and Workers are release gates.
- Portable TCP/TLS and worker-thread adapters replace runtime I/O only. The
  real embedded backend is loaded under Bun and remains Bun-only.

### Removed

- Removed the StrykerJS mutation gate, its `stryker.config.mjs` configuration
  and the `test:mutation` script. The engine's transitive dependencies were the
  only source of this package's advisory findings and never reached published
  code; the pure planners and snapshot validator stay covered by the fast-check
  campaigns in `bun run test:property`. The published runtime dependency set is
  unchanged (`msgpackr` only).

### Added

- Add independent-connection idempotency and single-lease race tests,
  fixed-seed generated payload invariants, malformed mutation fuzzing, and an
  opt-in sustained producer profile.

### Fixed

- A command issued before the broker listens now waits for the canonical
  reconnect under Node, Deno, and Workers, as it does under Bun. The portable
  transport reported every refused connection attempt as a lost connection,
  which rejected queued commands with `Connection lost` within milliseconds
  and made Workers emit repeated errors.
- The published JavaScript no longer uses top-level `await`, so CommonJS
  bundlers such as `esbuild --bundle --format=cjs` accept it again. Under Bun
  the embedded engine now loads synchronously on first embedded use; Node,
  Deno, and Workers still never load it.
- The published declarations no longer reference `bun-types`, Bun globals, or
  `bun:sqlite`, and `bun-types`/`@types/node` are no longer runtime
  dependencies. Strict NodeNext projects with `@types/node` 20 or 22 now
  type-check with `skipLibCheck: false` (with or without the DOM library), and
  `Bun` is no longer declared in Node projects. The build fails if a Bun or
  DOM-only type reaches the published declaration graph again.
- Wake the saturated Worker pull loop when an ACK or FAIL releases a
  concurrency slot, retaining the existing 20 ms fallback while avoiding a
  full polling delay between completion waves.
- Treat broker-authoritative late `ACK`/`FAIL` outcomes as ignored rather than
  locally completed or failed. Batched ACKs now use `ignoredIndices`, so
  duplicate job IDs are settled by input position without false events or
  counter increments.
- Forward a Worker-owned Job's lease token through `retry()`, `changeDelay()`,
  `moveToDelayed()`, and `discard()`, and accept the token on the matching Queue
  mutation methods. Active transitions now satisfy broker ownership instead
  of failing, silently leaving the job active, or allowing an old delivery to
  discard a newer generation.
- Negotiate wire protocol v3 and advertise the `separate-job-name`
  capability in `Hello`.
- Send `PUSH`/`PUSHB` names through top-level `name`, preserve user `data`
  without wrapping or reserving `data.name`, decode legacy envelopes on read,
  and send scheduler job names through `jobName`.
- Forward the optional `duration` from `setGlobalRateLimit(max, duration)` to
  the broker instead of silently applying the one-second default.
- Let the operating system allocate an independent HTTP port for every E2E
  broker fixture, preventing nested auth and restart fixtures from colliding
  with an adjacent TCP listener.
- Emit dependency-free, typed, sanitized `error` telemetry for connection,
  socket, write, and serialization failures without forwarding raw error
  messages, tokens, commands, or payloads.
- Reject MessagePack payloads larger than the protocol's 64 MiB frame cap
  locally with `SerializationError`, before allocating or writing the framed
  buffer.
- Normalize MessagePack encoder failures to `SerializationError` and serialize
  commands before registering their timer, pending entry, or backpressure slot,
  preventing malformed commands from reducing connection capacity.
- Validate command values recursively: reject `BigInt`, non-string map keys,
  cycles, non-finite numbers, accessors, symbols, functions, and non-portable
  object types while retaining standard objects, arrays, dates, and binary.

## [0.1.10] - 2026-07-30

Never published to npm; these changes first ship in 0.2.0.

### Added

- Add deterministic fast-check campaigns for generated flow trees, shrinking,
  ID uniqueness, graph closure, reciprocal links, shape isomorphism, option
  forwarding, chain/fan-in topology, and broker snapshot validation.
- Add a Stryker mutation gate scoped to the pure tree/legacy planners and
  snapshot validator, plus explicit Cloudflare Workers coverage for generated
  portable IDs.

### Fixed

- Compile trees, bulk trees, chains, and fan-in graphs with all IDs preallocated
  and commit them through one broker-side atomic `PUSHF` command. Partial
  `PUSH`/`UpdateParent` graphs and best-effort rollback are no longer possible.
- Map public `jobId` to the planned ID and wire `customId`, reject unsupported
  repeat/deduplication/debounce and caller-owned topology, protect internal data
  markers, reject `jobId` queue defaults, and reject nested children in flat
  flow methods.
- Validate the exact returned snapshot ID/queue set and build every public
  `FlowNode` from those committed snapshots.

## [0.1.9] - 2026-07-14

Conformance-suite driven: the SDK is now certified by the cross-language
conformance kit (`sdk/conformance`, 17/17) against the formal wire spec
(`docs/protocol.md`).

### Fixed

- **`drain()` now returns the number of removed jobs** (was `void`,
  silently discarding the wire `count` — the "discarded return value"
  class the conformance suite checks for).

## [0.1.8] - 2026-07-14

Spec-alignment audit against the core protocol. Every fix ships with a repro
test in `tests/e2e-spec-align.ts`.

### Fixed

- **`heartbeatIntervalS: 0` now disables heartbeats.** Previously it armed
  `setInterval(fn, 0)`, flooding the server with hundreds of `Heartbeat`
  commands per second. `0` (or negative) now matches the official client's
  "0 = disabled" semantics.
- **`batchSize` is clamped to the server maximum (1000).** The server rejects
  `PULLB` with `count > 1000`; an unclamped `batchSize` combined with
  `concurrency > 1000` wedged the pull loop in a permanent error cycle.
- **Simple Mode `cron()`/`every()` forward the execution `limit`.** The option
  was silently dropped (the "client drops a wire-supported field" class,
  #111); it now reaches the scheduler as wire `maxLimit`, matching the
  official client's signature.
- **`waitForJob()` clamps `ttlMs` to the server cap (600000).** Larger values
  were rejected by the server with "timeout must be at most 600000" instead
  of waiting.
- **`PROTOCOL_VERSION` bumped to 2**, matching the version the server
  advertises in `Hello`.

## [0.1.7] - 2026-07-10

Audit fixes: typed worker events, error-path hygiene and two more members of
the "client drops a wire-supported field" class (#111).

### Added

- **Typed Worker events.** `worker.on('completed', (job, result) => ...)` now
  gets typed `Job<T>`/`R`/`Error` parameters in strict mode instead of
  `unknown[]` (TS18046). The new `WorkerEventMap<T, R>` covers `ready`,
  `active`, `completed`, `failed`, `progress`, `error`, `drained`, `cancelled`
  and `closed`; unknown event names keep a generic overload, so existing code
  compiles unchanged. (H1)
- `"prepublishOnly": "bun run build"` so a publish can never ship a stale
  `dist/`. (H3)

### Fixed

- **Bunqueue constructor crash vector.** `new Bunqueue(..., { dlq })` fired
  `setDlqConfig` with no rejection handler: an unreachable server at
  construction time killed the process with an unhandled rejection. The
  failure now routes to the worker's `'error'` event (swallowed when no
  listener is attached, matching `pause()`/`resume()`). (H2)
- **ACK/completed asymmetry.** In the non-batched path the worker emitted
  `'completed'` and incremented `processed` even when the ACK never reached
  the server. Both the ACK and FAIL paths now mirror the batched semantics:
  on a wire failure only `'error'` fires, with no counter increment. Errors
  emitted on `'error'` are now always `Error` instances. (M1)
- **Not-found swallowing.** `getJobScheduler`, `getJob` and
  `getJobByCustomId` caught every error (including `ConnectionClosedError`
  and `CommandTimeoutError`) and returned `null`. The catch is narrowed to a
  `CommandError` matching `/not found/i`; everything else rethrows. (M2)
- **Scheduler template priority/deduplication dropped.**
  `upsertJobScheduler` put `priority` inside `jobOptions`, where the server's
  `CronJobOptions` ignores it, and never sent the template's deduplication.
  Both now travel as the top-level `priority`/`uniqueKey`/`dedup` Cron fields
  the handler reads, matching the reference client. (#111 class, F3)
- **moveJobToFailed lost the stack and the unrecoverable flag.** It sent only
  `error.message`; when given an `Error` it now sends the leading stack lines
  and `unrecoverable: true` for `UnrecoverableError`, mirroring the worker
  FAIL path. (#111 class, F4)

## [0.1.6] - 2026-07-09

Enterprise-grade hardening. All additive and backward-compatible; defaults are
unchanged (observability is silent, backpressure unbounded, ACK batching off).

### Added

- **Observability.** Every `Connection`/`Queue`/`Worker`/`FlowProducer` accepts
  an injectable `logger` and an `onTelemetry` sink (zero hard deps — bridge it to
  OpenTelemetry/Prometheus yourself). `TelemetryEvent` is a typed union covering
  per-command latency, connect/disconnect/reconnect, auth and backpressure.
  `Connection` is now an `EventEmitter` emitting `connect` / `disconnect` /
  `reconnect_scheduled`. Ships `noopLogger` (default) and `consoleLogger`.
- **Backpressure.** `maxInFlight` bounds concurrent in-flight commands; callers
  park until a slot frees instead of growing memory unbounded under load.
- **ACK batching.** Opt-in `Worker({ ackBatch: { enabled: true } })` coalesces
  completed-job ACKs into `ACKB` round-trips for higher throughput; a job stays
  active (lock renewed) until its batch is confirmed.
- **Connection pool.** `Queue({ poolSize: N })` fans producer commands across N
  round-robin connections (`ConnectionPool`, producer-side; workers stay single-
  connection by design).
- **Typed responses.** `call<R>()` is generic over the exported response shapes
  (`JobResponse`, `PulledJobsResponse`, `JobCountsResponse`, …); internal
  `as Record<string, unknown>` casts removed across the query/control/flow paths.

### CI

- GitHub Actions runs both SDK suites on every `sdk/`/`src/` change (TypeScript
  on Bun + Node + Deno, Python 3.10/3.12); an npm release workflow publishes
  with build provenance, gated on the e2e suite.

## [0.1.5] - 2026-07-08

Protocol-coherence audit against the bunqueue server. Every fix ships with a
RED→GREEN repro in `tests/e2e-audit-fixes.ts`.

### Fixed

- **addBulk dropped the custom job id.** PUSHB entries are `JobInput`
  (`customId`), not the single-PUSH `jobId` the server renames — the batch
  path now renames `jobId`→`customId`, so `getJobByCustomId` and idempotent
  bulk ingest work. (H1)
- **Half-open link wedge.** Enable TCP keepalive (~15s idle) and tear down the
  socket after 3 consecutive command timeouts so the next call reconnects,
  instead of wedging until the OS abandons the writes. The teardown is
  generation-guarded so a stale-connection timeout can't abort a fresh
  reconnect. (H2)
- **getFlow crashed on a missing job.** A missing root/child now yields `null`
  and is skipped (partial tree) instead of throwing; the catch is narrowed to
  `'not found'` so real server errors still surface, and a `visited` set guards
  against cycles now that depth defaults to unlimited. (H4)
- **waitForJob returned `undefined` on timeout.** It now rejects on
  non-completion: a `failed` job throws `CommandError`, otherwise
  `CommandTimeoutError` — the `completed` flag is no longer ignored. (M1)
- **getWaitingCount / getWaiting counted prioritized jobs.** Now waiting-only,
  matching BullMQ and the Python SDK. (M2)

### Changed

- `addJobLog(id, message, level?)` accepts an optional level;
  `getJobLogs` formats entries as `[level] message` (no longer drops the level).
- `retryJobs`: the dead `count` field is no longer sent on the wire (the server
  has no partial RetryDlq; `count` is accepted only for API parity).
- Worker `FAIL` keeps the leading stack lines (`slice(0, N)`) so the error
  message is preserved on long stacks.

## [0.1.4] - initial published release

- Cross-runtime (Node/Bun/Deno) TCP client: `Queue`, `Worker`, `FlowProducer`,
  `Bunqueue` Simple Mode, msgpack wire protocol, TLS, auth, pipelining.
