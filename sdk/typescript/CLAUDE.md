# bunqueue-client (TypeScript SDK) — development guide

Cross-runtime (Node/Bun/Deno) client SDK for the bunqueue server. Speaks ONLY
the native TCP protocol (msgpack). Parity reference: the official client in
`../../src/client/` (TCP mode — embedded/sandboxed/QueueEvents are excluded
by design: they require the in-process Bun runtime).

The normative behavioral contract is
[`INVARIANTS.md`](./INVARIANTS.md). Read it before changing transport,
serialization, Queue, Worker, FlowProducer, query, or admin code.

## Non-negotiable rules

1. **Never touch the bunqueue core** (`../../src/`): this SDK lives here only.
2. **Only `node:*` builtins** (`node:net`, `node:tls`, `node:events`,
   `node:crypto`, `node:os`) — that's what guarantees Node+Bun+Deno. ZERO
   `Bun.*` globals, zero `bun:`/`deno:` imports. NEVER send `BigInt` on the
   wire.
3. **Single runtime dependency: `msgpackr`** (top-level pack/unpack =
   standard msgpack; do NOT use `Packr` with records: it breaks interop).
   fast-check is a development-only dependency.
4. **Max 250 lines per file** — split into modules, don't compress.
5. **Relative imports with explicit `.js` extension** (NodeNext): without it,
   Node ESM cannot resolve.
6. **Oxlint, Oxfmt and tsc**: `bun run check` (lint, format, `bun run
   typecheck`) must be clean before any change is considered done.
7. **Protocol source of truth**: `../../src/domain/types/command.ts`
   (commands), `../../src/domain/types/response.ts` (responses),
   `../../src/infrastructure/server/handlers/` (actual shapes). When in
   doubt, read the handler — never guess.
8. Every new method → matching e2e test. All docs and comments in English.

## Structure

| File | Role |
|---|---|
| `src/errors.ts` | Error hierarchy + `UnrecoverableError` (→ FAIL `unrecoverable:true`) |
| `src/frame.ts` | Wire framing: O(n) cursor FrameParser, `frame()`, `compact()`, constants |
| `src/connection-base.ts` / `src/connection.ts` / `src/connection-types.ts` | `node:net`/`node:tls` socket lifecycle, lazy reconnect, Auth, response dispatch (base); reqId pipelining, Ping/Hello/close (connection.ts) |
| `src/timing.ts` | The only bridge to `../../src/shared/timers.ts` and `durations.ts` (imported, bundled, never copied): arm every option-driven timer with `safeTimeout`/`safeInterval`/`safeSleep`, never a raw `setTimeout` |
| `src/sdk-clamps.ts` | The SDK clamps of `../CLAUDE.md` rule 4 (heartbeat disable, `batchSize`, poll timeout, `waitForJob` ttl): a number never throws, non-finite means the default; they win over the main client's stricter rules (see `LEGACY.md`) |
| `src/legacy-coercion.ts` | 0.2.2 compatibility: `numericString` (a numeric string is its number) and `legacyDelay` (a one-shot delay: NaN or negative runs at once, as `setTimeout` did) |
| `src/validation.ts` / `src/bunqueue/validation.ts` | Constructor/method validation of every other duration and count (Connection, ConnectionPool, Queue, Worker, Simple Mode). Only values 0.2.2 turned into a hot loop, hang, crash or ~1 ms timer throw; every other value keeps its 0.2.2 result (`LEGACY.md`, "Option validation"). Tests in `tests/legacy-*.test.ts` (`legacy-compat-*` pass against 0.2.2), `tests/e2e-durations.ts` and `tests/e2e-legacy-compat.ts` |
| `src/types.ts` | `JobOptions` + mapping to wire fields, `jobPayload` |
| `src/job.ts` | Job: properties + per-id operations |
| `src/queue.ts` | Queue core (add/addBulk/lifecycle) + prototype-mixin merge |
| `src/queue-query.ts` / `src/queue-counts.ts` / `src/queue-control.ts` / `src/queue-admin.ts` | Queue area modules merged onto the prototype |
| `src/worker-base.ts` / `src/worker.ts` / `src/worker-types.ts` | Worker: lifecycle+cancel base, PULLB loop, heartbeats, events, options |
| `src/ack-batcher.ts` / `src/terminal-outcome.ts` | ACKB buffering and strict broker-authoritative ACK/FAIL outcome parsing |
| `src/flow.ts` / `src/flow-types.ts` | FlowProducer public creation/read API and types |
| `src/flow-plan.ts` / `src/flow-plan-legacy.ts` | Pure ID allocation and closed tree/chain/fan-in graph planning |
| `src/flow-commit.ts` | One `PUSHF` call plus exact snapshot ID/queue validation |
| `src/bunqueue/*.ts` | Simple Mode (`Bunqueue`): 1:1 port of `src/client/bunqueue*` — core+api (prototype merge), retry, circuit-breaker, batch, triggers, aging, cancellation, ttl, dedup-debounce, dlq-rate-limit, rate-gate |
| `tests/harness.ts` | Shared registry/asserts/server fixture/runner |
| `tests/integration.ts` | Smoke suite (10 tests, own entrypoint) |
| `tests/e2e.ts` | E2e entrypoint importing the full API, edge, realistic, telemetry, resilience, and hardening, duration and 0.2.2-compatibility suites (131 tests) |

## Wire protocol (VITAL gotchas)

- Frame = 4-byte big-endian u32 length + standard msgpack map. Request
  `{cmd, reqId, ...}`; response `{ok, reqId, ...}`; `ok:false` → `error`
  field. Max frame 64MB. Auth = first command `{cmd:'Auth', token}`.
- `PUSH`/`PUSHB` carry protocol-owned `name` beside untouched user `data`.
  Job readers prefer top-level `name` and retain legacy `data.name` fallback.
- Omit `undefined` keys from payloads (compact frames, parity with the
  official client).
- Responses **wrapped in `data`**: `GetLogs→data.logs`,
  `ListWorkers→data.workers`, `GetChildrenValues→data.values`,
  `AddWebhook→data.webhookId`, `ListWebhooks→data.webhooks`, `Ping→data.pong`.
- Responses **top-level**: `IsPaused→paused`, `CronGet→cron`,
  `GetProgress→progress/message`, `PULL→job+token`, `PULLB→jobs+tokens`,
  `PUSH→id`, `PUSHB→ids`, `Count/Clean→count`.
- `Progress` only works on **active** jobs.
- `lifo` orders only among jobs that are **both** lifo; mixed → FIFO.
- `GetJobs`/`PromoteJobs` read from SQLite (write buffer ~10ms): in tests
  wait for the flush, never assert right after a push.
- Not-found (`GetJob`, `GetJobByCustomId`, `CronGet`) → "not found" error:
  map it to `null`; don't leak the exception.
- Webhooks: localhost/private URLs rejected (SSRF guard); valid events look
  like `job.completed`.
- `retryJob` = `MoveToWait`; `retryJobs failed` = `RetryDlq`;
  `retryJobs completed` = `RetryCompleted`.
- `ListQueues` returns an array of **name strings**.

## Tests

```bash
bun install && bun run build      # bundles dist/ from ../../scripts/build-portable-client.ts (tests import from dist/)
bun run test:property             # deterministic planner/commit tests + legacy option/timer unit tests
bun run check                     # Oxlint + Oxfmt + typecheck
bun run typecheck                 # tsconfig.json (build options, all sources) + tsconfig.legacy.json (NodeNext, Node types only)
bun tests/integration.ts          # smoke
bun tests/e2e.ts                  # full e2e
node --experimental-strip-types tests/e2e.ts
deno run -A tests/e2e.ts
bun run test:workers              # packaged SDK inside workerd
BUNQUEUE_SDK_SOAK_SECONDS=3600 bun tests/soak.ts
```

Set `BUNQUEUE_FLOW_PBT_SEED=<signed-seed>` and
`BUNQUEUE_FLOW_PBT_PATH='<path>'` to replay fast-check output. This SDK has no
mutation engine (StrykerJS was removed); keep the planner/commit coverage in
`bun run test:property` and do not broaden those tests to broker E2E code. The
`tests/legacy-*.test.ts` files there are in-process unit tests: a stub
connection or, at most, a local socket that never answers, never a broker.

Tests spawn a real server (`bun src/main.ts` from the repo root, random
port, temp DB). The auth suite uses a dedicated server with `AUTH_TOKENS`.
Before declaring green: run on **every** available runtime.

## New-method checklist

1. Command in `command.ts`, response shape in its handler.
2. Method in the right module, same name as the official client
   (`getJobCounts`, `upsertJobScheduler`, …). Explicit types, no `any`.
3. Compact the payload; unwrap correctly (see gotchas).
4. E2e test in the right area; `bun run check` clean; `wc -l` ≤ 250.
5. Suites green on Node AND Bun (Deno when available). Update the README if
   the public surface changed. Keep the Python SDK (`../python/`) aligned or
   report the gap.
