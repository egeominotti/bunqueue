# Polyglot SDK quality contract

The six official network clients under `sdk/` share one production contract.
Language APIs remain idiomatic, while transport, delivery, safety, and
observability behavior must agree with `docs/protocol.md`.

## Official clients

| SDK | Producer | Worker | Flow | Verified TLS | Structured telemetry |
| --- | --- | --- | --- | --- | --- |
| TypeScript | yes | concurrent | yes | yes | callback + lifecycle events |
| Python | yes | concurrent | yes | yes | callback |
| PHP | yes | sequential | yes | yes | callback |
| Go | yes | concurrent | yes | yes | callback |
| Rust | yes | bounded threads | yes | yes | callback |
| Elixir | yes | `Task.async_stream` | yes | yes | callback |

The TypeScript SDK (`bunqueue-client` 0.2.0) ships the canonical
`bunqueue/client` API as its default entry, a breaking change from 0.1.x; the
0.1.x API stays at `bunqueue-client/legacy` (same surface; since 0.2.3 it
arms option-driven timers through `src/shared/timers.ts`, via
`sdk/typescript/src/timing.ts`, applies the SDK clamps of `sdk/CLAUDE.md` rule 4
to the heartbeat, `batchSize`, poll timeout and `waitForJob` ttl, and rejects
only values 0.2.2 turned into a hot loop, a hang, a crash or a ~1 ms timer;
every other value keeps its 0.2.2 result (`sdk/typescript/src/legacy-coercion.ts`;
see `sdk/typescript/LEGACY.md#option-validation`), and
`sdk/typescript/README.md#migrating-from-01x` is the migration guide. The
package is ESM-only (`require()` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`), has
one runtime dependency (`msgpackr`), no top-level `await` (CommonJS bundlers such
as `esbuild --format=cjs` accept it), and self-contained declarations that need
only the consumer's `@types/node`. Its README opens with the same tested quick
start as the docs (`test/docs-homepage-snippets.test.ts`). See [Canonical client parity](client-runtime-parity.md)
for the portable transport, embedded loader, and declaration gates.

### Release state

Protocol v3 (`separate-job-name`) clients were released with server 2.9.7 on
2026-10-02: TypeScript 0.2.1 (npm, `sdk-release.yml`), PHP 0.2.0 (Packagist reads
the `egeominotti/bunqueue-php` mirror) and Go `sdk/go/v0.2.0` (a git tag; the Go
proxy serves it). TypeScript 0.2.2 followed on 2026-10-03 with the canonical
client's job-wait fix (`src/client/jobWait.ts`) and the rewritten README.
TypeScript 0.2.3 followed on 2026-10-05 with server 2.9.11: duration and
count validation, shared timers in both entries, and pool keys that cover
every connection option and the full token hash.
Python 0.2.0 and Rust 0.2.0 are versioned and built in the
same release and are published by hand to PyPI and crates.io by the maintainer,
who holds those credentials. The previous registry releases (Python 0.1.5, PHP
0.1.1, Go v0.1.0, Rust 0.1.1, 2026-07-20) speak protocol v2 and lose the job
name against servers 2.8.57 and later; the SDK guide states the minimum
versions. The Elixir SDK is not on Hex. Only the TypeScript SDK has an automated
publication workflow (`sdk-release.yml`); the other registries are published by
hand, so a source change is not live until its registry release, and the
sandbox SDK gate tests source, not the published packages.

## Core feature parity audit

The source-level audit on **2026-08-01** compared the public Bun client with
the six TCP SDKs. Its conclusion is unambiguous: **no external SDK currently
has the complete core feature surface**. “Full” below means that the typed SDK
exposes the core behavior with the same selectors and queue scoping; “partial”
means that a subset exists or an exposed option has different semantics. A
dash means there is no typed helper, even if an application could issue a raw
protocol command itself.

| Core surface | TypeScript | Python | PHP | Go | Rust | Elixir |
| --- | --- | --- | --- | --- | --- | --- |
| Producer, bulk add, job options | Full | Full | Full | Full | Full | Full |
| Worker delivery, leases, heartbeat, ACK/FAIL | Full | Full | Full¹ | Full | Full | Full |
| State queries and exhaustive pagination | Partial² | Partial² | Partial² | Partial² | Partial² | Partial² |
| Non-serialization `Job` operations | 13/32 | 13/32 | 4/32 | 4/32 | 3/32 | 2/32 |
| Dedup owner lookup and key release | Partial³ | Partial³ | — | — | — | — |
| Dependency pagination/counts and waiting-children transition | Partial | Partial | Partial | Partial | — | — |
| Rate/concurrency mutation | Full | Full | Partial⁴ | Partial⁴ | Partial⁴ | Full |
| Rate/concurrency readback and max/TTL status | — | — | — | — | — | — |
| Rich DLQ entries, statistics, filtered retry | — | — | — | — | — | — |
| Bulk retry with state/count/timestamp selectors | Partial⁵ | Partial⁵ | — | — | — | — |
| Atomic flow tree and chain creation | Full | Full | Full | Full | Full | Full |
| Flow bulk, fan-in, and tree readback | Full | Full | Read only | Read only | — | — |
| Queue-scoped worker discovery | Partial⁶ | Partial⁶ | Partial⁶ | Partial⁶ | — | — |
| Scheduler CRUD and queue-scoped list | Full | Full | Partial⁷ | Partial⁷ | Partial | Partial⁷ |
| Stats, metrics, and webhooks | Full | Full | Partial⁸ | Partial⁸ | — | — |
| Queue groups and store-and-forward | — | — | — | — | — | — |
| Simple all-in-one mode | Full | Full | — | — | — | — |
| Workflow/saga engine | — | — | — | — | — | — |
| Authentication, verified TLS, telemetry | Full | Full | Full | Full | Full | Full |
| Embedded SQLite, queue events, sandboxed workers | Bun-only | Bun-only | Bun-only | Bun-only | Bun-only | Bun-only |

Audit notes:

1. PHP intentionally processes sequentially; this is a worker model choice,
   not a delivery-correctness gap.
2. All SDKs can request finite offset/limit pages. None mirrors the Bun
   client's exhaustive `end=-1` contract: TypeScript substitutes a 1,000-row
   cap, Python converts it to a zero limit, and the other clients expose only a
   finite limit. Applications must paginate explicitly.
3. TypeScript and Python expose an owner lookup but route it through
   `GetJobByCustomId`. Custom IDs and deduplication keys are separate indexes,
   so this can return the wrong answer; neither SDK exposes key release.
4. PHP, Go, and Rust preserve rate duration/TTL but expose no global
   concurrency mutation helper.
5. Failed-job count works. Completed retry drops `count`, neither client
   exposes the terminal `timestamp` cutoff, and TypeScript discards the applied
   count from its return type.
6. These SDKs decode `ListWorkers` but return the server-wide registry rather
   than filtering it to `queue.name`; their count helpers are global too.
7. PHP, Go, and Elixir return every server scheduler from `CronList`, not just
   the current queue. Rust has create/get/remove but no list helper and lacks
   some scheduler flags.
8. PHP and Go expose stats and webhooks but not metrics; Rust and Elixir expose
   none of the three typed surfaces.

The full 32-method Bun `Job` denominator excludes `toJSON` and `asJSON`.
TypeScript/Python cover progress, logging, state, remove/retry, child values,
data/priority/delay mutation, promote, lock extension, delayed transition, and
discard. PHP/Go cover progress, logging, state, and lock extension; Rust covers
progress, logging, and lock extension; Elixir covers progress and logging.

As a secondary transport diagnostic, the broker command union contains 89
literal commands. The production source trees reference 74 in TypeScript, 74
in Python, 56 in PHP, 56 in Go, 44 in Rust, and 51 in Elixir. These are **not
parity percentages**: the union includes dashboard, maintenance, and alternate
primitive commands, while one higher-level feature can compose several
commands. The method/semantics matrix above is the authoritative audit.

The TypeScript and Python duration gap found by this audit is closed by a
real-broker regression that reads the applied window through `GetQueueLimits`.
The Elixir `deduplication` gap is closed too: its `id` now becomes `uniqueKey`
and only `ttl`/`extend`/`replace` travel as `dedup`, proven against a real
broker by `sdk/elixir/test/deduplication_options_test.exs`.
The remaining gaps require separate per-SDK TDD changes and the mandatory
`bun run test:sandbox:sdk` gate.

WebAssembly is not treated as a seventh runtime yet. Browser WASM has no
portable raw-TCP primitive, while WASI socket and TLS support depends on the
host. A future WASM client must either target an authenticated HTTP/WebSocket
bridge or a capability-enabled WASI host and pass the same conformance and
telemetry contract before it is listed as official.

## Required invariants

Every SDK must:

1. frame standard MessagePack maps with a 4-byte big-endian body length and
   reject serialization failures and bodies above 64 MiB before allocating or
   writing the frame, without retaining a timer, pending entry, or capacity
   slot;
2. send `Auth` before any other command on each connection generation;
3. correlate replies with `reqId`, tear down ambiguous timed-out streams, and
   reconnect lazily with bounded backoff;
4. recursively make integers JavaScript-safe, keep wire maps string-keyed
   (reject or explicitly stringify non-string associative keys while
   preserving lists), and normalize ext type 0 to the language's null value;
5. preserve every advertised job, scheduler, rate-limit, and flow option
   instead of silently dropping fields;
6. clamp batch and long-poll values to protocol limits, and validate or
   normalize every duration before it reaches a timer, sleep, socket deadline
   or backoff (see [Duration validation](#duration-validation));
7. keep active job leases alive, bound pulls by available concurrency, and
   surface ACK/FAIL errors;
8. plan every flow completely before I/O and submit it with one atomic `PUSHF`,
   so validation or transport failure creates no partial graph;
9. expose typed connection, timeout, command, authentication, protocol, and
   unrecoverable-processing errors;
10. treat the broker's terminal transition response as authoritative: an exact
    `already-finalized` lease generation must not emit a contradictory local
    terminal event or increment a terminal counter, and ACK batches must use
    `ignoredIndices` rather than infer positions from duplicate-capable IDs.

## Atomic flow contract

Each SDK owns a pure planner for trees, chains, and fan-in graphs. The planner
allocates every ID before transport, rejects empty/duplicate IDs, cycles,
shared nodes, reserved metadata keys, unsupported option combinations, excessive
depth/size, and produces reciprocal `parentId`/`childrenIds`/`dependsOn` edges.
Only a valid plan is encoded as one `PUSHF` command. Returned flow nodes are
rebuilt from the broker's authoritative snapshots, with an exact cardinality
and ID-set check; clients never synthesize a successful graph after a partial
or malformed response.

`UpdateParent` remains a server compatibility command for already-published SDK
versions. It is not part of current official `FlowProducer` creation.

## Telemetry contract

Telemetry is opt-in and dependency-free. Each SDK emits the idiomatic
equivalent of connection/reconnection, authentication, command latency and
outcome, timeout, transport error, and close events. Worker retry events are
included where a retry loop exists.

Callbacks are isolated from queue correctness: a callback exception or panic
must not fail a command, poison a connection mutex, or leak a worker slot.
Events may contain endpoint, generation, command name, request id, duration,
outcome, and sanitized error text. They must never contain authentication
tokens, job payloads, job results, private keys, or CA contents.

## Saturated worker wake-up

The TypeScript and Python workers use a one-shot completion signal while all
local concurrency slots are occupied. A settled ACK/FAIL wakes the pull loop
immediately; the previous 20 ms (TypeScript) and 50 ms (Python) waits remain as
bounded fallbacks. This changes only local poll scheduling: PULLB limits, lease
tokens, heartbeat membership, ACK/FAIL authority, events, counters, and close
ordering are unchanged.

The change was selected from a native three-round A/B campaign on an Apple M1
Max with 20,000 trivial jobs, concurrency and pull width 64, ACK batching width
64, 10,000 flow nodes, and fresh broker/database state for every process. The
median TypeScript Worker phase fell from 8,164.67 ms to 4,219.41 ms (-48.3%;
2,449.6 to 4,739.9 jobs/s), while Python fell from 19,676.10 ms to 4,683.93 ms
(-76.2%; 1,016.5 to 4,269.9 jobs/s). Median process user+system CPU fell from
0.73 s to 0.65 s for TypeScript and from 1.44 s to 1.09 s for Python.

Equivalent candidates were rejected when the same A/B did not justify a code
change: the Go wake signal made its Worker phase 3.1% slower; suppressing Rust's
per-job heartbeat thread changed Worker time by only -0.4%; and caching Elixir
worker registration saved only 0.7% while increasing retired instructions.
PHP's sampled profile was dominated by socket polling and exposed no
application self-time hotspot. These clients therefore retain their existing
lifecycle behavior until a separately measured optimization clears the same
bar.

## Duration validation

A duration from options or job data must never reach a timer, a sleep, a
socket deadline or a backoff as NaN, a negative number, a zero that becomes a
spin or an instant timeout, or a value above the runtime's limit. A NaN or
negative one-shot delay that the previous release ran at once still runs at
once.

Each SDK keeps every value its previous release handled as intended. It
rejects or normalizes only values that release turned into a hot loop, a
~1 ms timer or lease, a hang, a crash, a request the broker always refused,
or an integer wrap. The previous releases differ, so the per-SDK results for
`null`/`None`/`nil`, non-numbers and fractions differ on purpose.

### The four SDK clamps

Four options follow `sdk/CLAUDE.md` rule 4 (`docs/protocol.md` sections 6.3
and 9) in every SDK. No SDK raises for a number in these options, and each
clamps a number as below; the per-SDK notes give the exceptions:

| Option | Rule |
| --- | --- |
| Heartbeat interval | `<= 0`, NaN or ±Infinity disables heartbeats. A positive value is kept, capped only at the runtime timer limit. |
| Batch size | Clamped to [1, 1000]. |
| Poll timeout | Clamped to [0, 30000]. NaN means 5000. |
| `waitForJob` ttl | Clamped to [0, 600000]. An omitted ttl means 30000. |

Per SDK:

- Python (`bunqueue/sdk_clamps.py`) keeps every working 0.2.0 result:
  - `None` means the default: a 10 s heartbeat, a batch of 10, a 5000 ms
    poll and a 30000 ms wait.
  - `batch_size` and the wait keep 0.2.0's `max(low, min(value, high))`. A
    NaN batch size is 1, a NaN wait is 0, and a bool counts as 0 or 1.
  - `heartbeat_interval_s=False` disables heartbeats, and `True` beats every
    second.
  - A bool poll timeout raises `TypeError`; 0.2.0 sent it and the broker
    refused it. Any other non-number raises `TypeError` naming the option.
- PHP (`src/OptionGuard.php`) keeps every working 0.2.0 setting. None of the
  four throws, and an omitted or `null` key means the default:
  - `batchSize`: an int is clamped. Any other value, a float or a string
    included, means 10.
  - `pollTimeoutMs`: an int, a float or a numeric string such as `'5000'` is
    clamped before the int cast, and `NAN` means 5000. Any other value means
    0, a non-blocking pull.
  - `heartbeatIntervalS` is converted with `(float)`: `'10'` is 10 s, and
    `false` disables heartbeats.
  - `waitForJob()` takes `int|float|null`: `null` or `NAN` means 30000, and
    `INF` holds for 600000.
  - The poll timeout and the wait truncate a fraction after clamping.
- Elixir (`Worker.new/3`, `Queue.wait_for_job/2,3`) is compatible with
  0.1.1. BEAM floats cannot be NaN or Infinity.
  - `nil` and non-numbers mean `batch_size` 1, `poll_timeout` 0, a
    `wait_for_job` 0 ms hold, and disabled heartbeats for `nil`, `false` or
    another atom.
  - Only `heartbeat_interval: true` or another non-atom non-number raises
    `ArgumentError`.
  - Fractions of the heartbeat interval, poll timeout and wait are truncated,
    but a non-integer `batch_size` is 1, as in 0.1.1. A positive heartbeat
    interval is at least 1 ms.
  - An omitted `batch_size` follows `concurrency`, and an omitted wait
    (`wait_for_job/2`) is 30000.
- The legacy TypeScript entry (`sdk/typescript/src/sdk-clamps.ts`) keeps
  every working 0.2.2 result:
  - An omitted or `null` value means the default, except a `null` ttl, which
    is a 0 ms hold.
  - A non-number heartbeat interval disables heartbeats. A non-finite or
    non-number `batchSize` means 10, and a fraction is kept.
  - A numeric string poll timeout or ttl is its number, and NaN means the
    default. Any other non-number raises `TypeError`.
- Go and Rust: their static types exclude non-numbers. Only Go's
  `HeartbeatIntervalS` is a float, so NaN and ±Inf disable it; the other
  clamps apply to integer fields.
  - Go's zero value means "omitted": `BatchSize: 0` means 10 and
    `PollTimeoutMs: 0` means 5000. A negative poll timeout clamps to 0, a
    non-blocking pull. `WaitForJob(id, 0)` is a 0 ms hold.
  - Rust's `heartbeat_interval: None`, or a zero `Duration`, disables
    heartbeats. `batch_size: 0` clamps to 1.

The runtime caps on a positive heartbeat interval are:

- Go: [1 ms, maximum `time.Duration`];
- Elixir: [1, 2^32 - 1] ms;
- Python: `threading.TIMEOUT_MAX`.

Without these caps the value would panic, crash a timer process, or become a
zero-delay loop.

### Other durations

No protocol rule pins the following options. Each SDK checks them at its
boundary in its own idiom, under the same compatibility rule, so it can
accept a value the main client (`src/shared/durations.ts`) rejects.

- After a pull that returned no jobs, the worker loop waits exactly as the
  main client does (`src/client/worker/runtime/polling.ts`:
  `pollTimeout > 0 ? 10 : drainDelay`):
  - 10 ms after an empty long poll;
  - 50 ms, the default `drainDelay`, after an empty non-blocking pull
    (timeout 0).

  One-shot APIs (`run_once`, `runOnce`) return at once.
- The lock TTL is at least 1 ms, because a lease of 0 or less is already
  expired when it is granted:
  - Python takes a finite number >= 1, capped at 2^53 - 1, or `None`. `None`
    sends `lockTtl: null`, and the broker leases for its 30000 ms default.
    NaN, infinity, a value below 1, a bool or a string raises at construction.
  - PHP takes an int >= 1 and throws `\InvalidArgumentException` for any
    other value. An omitted or `null` key means 30000.
  - Elixir: `nil` means 30000, a positive float is rounded up, and a value
    above 2^53 - 1 is capped. Zero, negative and non-number values raise
    `ArgumentError` before any worker process starts.
  - Go and Rust, whose constructors are infallible and already default zero
    values, use 30000 for zero or less.
- Connect and command timeouts are positive:
  - Python raises on construction for a zero, negative or NaN timeout and
    for an infinite `connect_timeout` (`ValueError`; `TypeError` for a
    non-number). `True` still means 1 s. `command_timeout=None` or
    `math.inf` means no client deadline, and `connect_timeout=None` keeps
    0.2.0's blocking connect, with no client deadline.
  - PHP throws `\InvalidArgumentException` on construction for a zero,
    negative, non-finite or non-number timeout. An omitted or `null` one
    means the default.
  - Go treats a value of zero or less as the default.
  - Rust returns `Error::Connection` before any socket opens.
  - Elixir: a configured timeout below 1 ms, or a non-number, falls back to
    the 30 s default. A per-call timeout of at least 0 but below 1 ms, `nil`
    or `false` uses the connection's timeout, and a negative or non-number
    one the 30 s default. Both cap at 2^32 - 1 - 2000 ms.
  - PHP caps at 2,147,482 s (about 24.85 days). Above that, `php_tvtoto()`
    turns a stream timeout into an infinite poll, and beyond `PHP_INT_MAX` the
    `(int)` cast wraps.
- Elixir's `Worker.stop/1` always returns. The lifecycle barrier monitors every
  admitted run and every stopper. A run whose process dies without leaving
  (a linked crash) is released by its `:DOWN`, while a live run is still
  waited for. If the stop owner dies, a waiting stopper takes over.
- Go's `Stop` interrupts every pull-loop wait: the empty-pull pause, the error
  backoff and the busy-slot wait each select on a per-`Run` stop channel.
  `Run` used to wait them out, measured at 47 ms in an empty-pull pause and
  480 ms in a backoff; it now returns in under 1 ms.
- Python's reconnect backoff stays within 0.5–5 s for any failure count. The
  Worker pull loop classifies a failure as the main client does
  (`sdk/python/bunqueue/worker_errors.py`):
  - A transient failure (a lost connection, a command timeout, the rate
    limit, a lock acquisition timeout, `Internal server error`) emits `error`
    and is retried after 0.5, 1, 2, then 5 s, the 0.2.0 schedule. A pull the
    broker answers resets it.
  - A permanent refusal (a bad token, a validation error) or an unexpected
    exception ends the loop and is raised from `run()`, as in 0.2.0. With an
    `error` listener attached, it is emitted and retried on the same schedule.

  `ack_batch.max_delay_ms` is still read with `float()`; only an infinite
  delay newly raises. Simple Mode rejects, before the Queue and Worker exist,
  only the `retry`, `circuit_breaker`, `batch`, `priority_aging` and
  `rate_limit` values 0.2.0 could not handle (`bunqueue/simple/validation.py`).
  Every other value there keeps 0.2.0's `snake or camel or default` reading,
  so 0 means the default. Computed retry backoffs saturate at 2^53 - 1 ms.
- The legacy TypeScript entry rejects only values 0.2.2 turned into a hot
  loop, a hang, a crash or a ~1 ms timer. `src/legacy-coercion.ts` keeps the
  other 0.2.2 results: a numeric string is its number, and a NaN or negative
  one-shot delay runs at once. `LEGACY.md` ("Option validation") lists each
  option.

The regressions that motivated these rules were measured before the fix:

- At poll timeout 0, Python, Go, Rust and PHP sent about 10,000 PULLB per
  second until the broker's anti-abuse rate limit cut them off; the legacy
  TypeScript entry sent 8,244 and Elixir 5,000. Each fixed SDK now sends
  about 20.
- At a 1 ms poll timeout, the SDKs sent 324 to 734 PULLB per second. They
  now send 65 to 77, within the 10 ms rule's bound of about 90.
- The four rule-4 options:
  - Python sent a NaN or negative poll timeout to the broker, which rejected
    the PULLB and shut the worker down. A `None` batch size or wait raised,
    and a `None` heartbeat killed the loop with `TypeError`.
  - PHP's int cast turned a `NAN` or `INF` poll timeout into 0 and wrapped a
    float beyond the int range (`1e19` became 0, `2^64 + 8192` became 8192).
    A `null` or non-finite `waitForJob` ttl threw PHP's own `TypeError`.
  - Elixir silently disabled heartbeats the caller asked for (`true`, a
    string); it now raises `ArgumentError`. Its other `nil` and non-number
    mappings are kept for 0.1.1 compatibility: 0, 1, disabled heartbeats,
    and a 0 ms wait.
- Elixir turned `nil`, every float, and zero, negative or non-number
  `lock_ttl` values into a 1 ms lease that expired mid-job. Python, PHP, Go
  and Rust sent a lock TTL below 1 to the broker as given.
- A Python priority-aging interval of NaN ran about 27,000 aging ticks per
  second.
- Python raised `OverflowError` after about 1,025 failed reconnects, and a
  transient broker refusal (the rate limit, a lock timeout,
  `Internal server error`) ended its Worker loop for good.
- Go panicked on sub-nanosecond heartbeat intervals.
- Elixir truncated a heartbeat interval below 1 ms to 0, a `JobHeartbeatB`
  loop per job, and raised `:timeout_value` for heartbeat intervals and
  timeouts above 2^32 - 1 ms.
- A NaN or infinite `commandTimeout` made PHP busy-spin socket reads. A finite
  one above `PHP_INT_MAX` seconds wrapped in the `(int)` cast: `1e300`
  busy-spun, `1e19` never timed out, and `2^64 + 8192` timed out after 8192 s.
- A linked crash in a handler could leave Elixir's `stop/1` waiting forever.

Each SDK covers these cases in its native suite:

- Python: `sdk/python/tests/e2e_durations*.py`,
  `sdk/python/tests/e2e_sdk_clamps.py`, `sdk/python/tests/e2e_compat.py`,
  `sdk/python/tests/e2e_worker_refusals.py` and
  `sdk/python/tests/test_compat_*.py`
- Go: `sdk/go/duration_validation_test.go` and `sdk/go/stop_latency_test.go`
- Rust: `sdk/rust/tests/duration_validation.rs`
- PHP: `sdk/php/tests/e2e-durations.php`, `sdk/php/tests/e2e-clamps.php` and
  `sdk/php/tests/e2e-compat.php`
- Elixir: `sdk/elixir/test/duration_validation_test.exs`,
  `sdk/elixir/test/option_clamps_test.exs`,
  `sdk/elixir/test/option_compat_test.exs` and
  `sdk/elixir/test/worker_stop_test.exs`
- TypeScript legacy entry: `sdk/typescript/tests/legacy-*-durations.test.ts`,
  `sdk/typescript/tests/legacy-compat-*.test.ts`,
  `sdk/typescript/tests/e2e-durations.ts` and
  `sdk/typescript/tests/e2e-legacy-compat.ts`

## Test layers

Native regression suites cover protocol encoding, option mapping, failure
classification, timeout/reconnect behavior, authentication, TLS verification,
worker concurrency/lease behavior, atomic flow rejection, and telemetry
isolation.
The shared conformance suite then validates 18 public protocol behaviors
against a fresh broker through each SDK's real driver. Every official SDK must
pass the same checks twice: once with the unchanged SQLite backend and once with
PostgreSQL 18.6. Storage remains a broker concern. Driver processes retain their
language toolchain environment, while a case-insensitive policy removes
bunqueue, PostgreSQL/libpq, AWS/S3, storage/TLS, and delimiter-named credential
variables; endpoints and optional tokens arrive only through the driver
protocol. Collision tests keep non-secret toolchain names available. This
reduces accidental disclosure but does not turn repository-owned driver code
into an untrusted-code sandbox. The PostgreSQL harness assigns every broker an
isolated namespace, confirms exit with bounded `SIGTERM`/`SIGKILL` handling,
and only then deletes its rows. Startup failures follow the same ownership
order. The gate waits for every started SDK suite before aggregate cleanup.
Docker teardown checks exit status, retains failed resources for retry, never
claims a container name before successful creation, and aggregates startup plus
cleanup errors. Its thin CLI runner, server/driver
harness, independent wire verifier, shared check support, and two check groups
are separate TypeScript modules so process orchestration cannot silently become
part of the verification oracle.

Each native suite also exercises realistic broker-backed business flows. The
common invoice-reconciliation scenario bulk-enqueues distinct payloads, drains
them with the SDK's real worker model, reads every persisted result by job id,
and verifies a deterministic checksum. Together with the retry/DLQ, burst,
heartbeat, graceful-shutdown, and flow tests, this detects job loss, duplicate
accounting, result cross-talk, and lease regressions beyond command-level
conformance. Every language now has deterministic generated-payload corpora,
concurrent custom-id idempotency and single-lease races across independent
live connections, malformed-input recovery, and a bounded producer spike. Go
adds the native race detector plus a first-class fuzz target. Rust and Elixir
use hard broker termination to prove durable jobs remain visible through
restart; the TypeScript, Python, PHP, and Go suites retain their equivalent
restart coverage.

Each SDK additionally runs native property-based tests over its pure flow
planner. TypeScript uses fast-check; Python, PHP, Go, Rust, and Elixir use their
ecosystem equivalents so generated values and shrinking integrate with the
native runner. Shared invariants cover conservation, unique IDs, reciprocal
edges, acyclicity, ordering semantics, reserved metadata, option preservation,
determinism under a supplied ID stream, and no transport call for invalid
input. Seeds and minimized counterexamples are printed by the native tools.

Mutation testing is a distinct scheduled/manual campaign after the bounded
suite is green. Every SDK except TypeScript has a pinned mutation engine scoped
to the planner and its properties. Surviving mutations are either killed with a stronger invariant
or documented as equivalent; mutation is not placed inside the ordinary
test-driven edit loop or the offline release sandbox. The workflow may make a
ratchet stricter than the tool configuration, but it may not override it with a
lower value; in particular, PHP's Infection gate enforces the checked-in 99%
MSI and covered-MSI floor.

A mutation job must provision every toolchain its SDK suite spawns, not only
the mutation engine. The Go campaign gathers baseline coverage by running
`go test`, whose `TestMain` starts a real broker with `bun src/main.ts`, so the
job installs the pinned Bun version alongside Go; without it the campaign dies
at `server start failed: exec: "bun": executable file not found in $PATH`
before a single mutant is generated.

The weekly advisory job audits each SDK's own dependency graph, including the
mutation toolchain, which is where transitive advisories usually surface. That
is why the TypeScript SDK no longer has one. StrykerJS pulled the only advisory
findings this repository ever had to answer for — `qs@6.15.1` through
`typed-rest-client` (GHSA-q8mj-m7cp-5q26), then `fast-uri@3.1.4` through `ajv`
(GHSA-7p8r-x3mc-p8w7) — and neither package was ever reachable from the
published client. Pinning overrides for a development-only mutation engine
traded recurring audit noise for no user-visible safety, so the engine was
removed instead. The TypeScript planners keep their generated-property coverage
via fast-check in `bun run test:property`, and the other five SDKs still mutate
the same planner and snapshot-validator surface.

The manual TypeScript SDK publisher accepts only the current `origin/main`
commit. Selecting a feature branch or a stale main commit in the Actions UI
fails before dependencies are installed, packaged artifacts are created, or
registry credentials are used. It packs `bunqueue-client-<version>.tgz` once,
requires the requested version to match `sdk/typescript/package.json`, treats
only Git exit status 2 as an absent `sdk-ts-v<version>` tag and only a registry
404 as an unpublished version, then verifies `bun pm whoami` and
`bun publish --dry-run` on that tarball before publishing the same tarball.
The pinned Bun CLI reads the token only from `NPM_CONFIG_TOKEN` (it ignores the
`setup-node` `.npmrc`), so `NPM_TOKEN` is passed under that name to the dry-run
and publication steps only. Bun produces no npm provenance, so none is
requested and the job holds no `id-token` permission. The tag is pushed only
after publication succeeds. See [Testing](../testing.md#ci).

Each SDK also owns an opt-in sustained profile that reuses one connection while
repeatedly adding, querying, and resetting configurable batches. Weekly CI runs
these profiles for 15 minutes, runs the compatibility matrix, and checks live
dependency advisories. The normal sandbox remains bounded and reproducible.

`bun run test:sandbox:sdk` is the authoritative gate. It builds six pinned
toolchain images and runs format/static checks, package-manifest builds, native
tests, and conformance in parallel. Suite containers and one disposable
PostgreSQL 18.6 container share a dedicated Docker-internal network with no
external route; there are no host mounts, credentials, home directories, or
Docker sockets. Each suite runs conformance first with SQLite and then with its
isolated PostgreSQL namespace. The gate emits complete logs, container resource
samples, per-suite JSON, and aggregate
`summary.json`/`summary.md` under `artifacts/test-sandbox-sdk/<timestamp>/`.

Any change below `sdk/` must pass this gate in addition to the core
`bun run test:sandbox` gate.

The GitHub release graph calls `.github/workflows/sdk.yml` as a reusable
workflow. Its six language jobs converge on `sdk-gate`; the root `quality-gate`
requires that result together with every core/docs suite, and all binary,
container, GitHub-release, and npm publication paths are downstream. The SDK
workflow has no separate push trigger, avoiding a race where publishing could
finish before an independent SDK failure arrived.

SQLite disk-full, WAL/power-loss, and schema migration tests remain broker
responsibilities. An SDK cannot inject a filesystem failure into a remote
database; it instead proves typed connection failure, lazy reconnect, durable
job visibility, and producer idempotency. The delivery contract is
at-least-once, not exactly-once processing.
