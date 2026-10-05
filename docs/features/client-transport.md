# Client Transport (TCP pool, reconnect, batching)

> **Category:** Client SDK · **Source:** `src/client/tcpPool.ts`, `src/client/tcp/` (option validation and 2.9.10 normalization in `tcp/options.ts`, numeric-string coercion shared by the client options in `tcp/numeric.ts`), `src/client/tcp/runtime/`, `src/client/tcp/types/`, `src/client/tcpClient.ts`, `src/client/queue/addBatcher.ts`, `src/client/queue-events/tcpSubscription.ts`

## Purpose

The client transport layer is the wire-level plumbing that the [Queue](./client-queue-sdk.md) and [Worker](./client-worker-sdk.md) SDKs use to talk to a remote bunqueue server over TCP. It owns the socket lifecycle: a load-aware connection pool (`TcpConnectionPool`), per-connection request/response multiplexing with msgpack framing and reqId-based pipelining (`TcpClient`), ordered short-write buffering, automatic reconnection with exponential backoff (`ReconnectManager`), liveness detection via ping and half-open-socket recovery (`HealthTracker`), optional TLS, and transparent write coalescing of `add()` calls (`AddBatcher`). It exists so the higher-level SDKs can issue command objects and await responses without managing sockets, retries, or batching themselves.

## Responsibilities & Scope

Owns:
- Validation of every numeric `ConnectionOptions` / `PoolOptions` value where a client, a shared pool or a shared client is built (`tcp/options.ts`), so a value the runtime would turn into a ~1 ms timer throws at construction instead (see [Option validation](#option-validation)).
- TCP connection establishment (plaintext or TLS), `connectTimeout` enforcement (a timed-out attempt closes its socket), and OS-level TCP keepalive setup (`tcp/transport.ts`).
- Connection ownership: one current socket per client (`generation`), so `close()` wins over an attempt in flight and a retired socket's late events never reach the current connection (see [Connection ownership](#connection-ownership)).
- Frame parsing / framing of msgpack-encoded command and response objects (delegated to `FrameParser` from the [TCP protocol](./tcp-protocol.md) module).
- Per-physical-socket outbound ordering: partial `Bun.Socket.write()` results are
  retained, later frames queue behind the missing tail, and `drain` resumes the
  write without replaying bytes across reconnects.
- Request/response correlation via per-command `reqId`, pipelining up to `maxInFlight` commands, and per-command timeouts (the connection's `commandTimeout`, or a command's own `send(command, { timeout })`).
- Dispatch of unsolicited `{ type: 'event', event: JobEvent }` frames before
  request correlation, so a subscription event cannot satisfy or reorder an
  in-flight command.
- Reconnection scheduling with overflow-safe exponential backoff + jitter and a configurable attempt cap.
- Connection health: periodic ping, ping-failure counting, and half-open detection (sustained command timeouts force a reconnect, #94).
- Pooling: round-robin load-aware client selection, reference-counted shared pools keyed by `poolSize` plus every resolved connection option (`tcp/poolKey.ts`).
- Auto-batching of `Queue.add()` calls into a single `addBulk`/`PUSHB` round-trip.
- Dedicated authenticated, reconnecting queue-event subscriptions used by
  `QueueEvents` and TCP Worker `stalled` notifications.

Does NOT own:
- The wire format / framing algorithm itself — see [TCP Wire Protocol & Framing](./tcp-protocol.md) (`FrameParser`, `pack`/`unpack`).
- Command semantics (what `PUSH`/`PULL`/`ACK` do server-side) — see [TCP Server Command Handlers](./tcp-server-handlers.md) and [Job Lifecycle](./job-lifecycle.md).
- Embedded (in-process) mode — when `embedded: true`, the SDK bypasses this layer entirely and the pool/batcher are `null` (`queue/runtime/state.ts:31-38`).
- Higher-level retry/DLQ/stall policy — see [Client SDK: Queue](./client-queue-sdk.md).
- Worker re-registration logic (the transport only emits the `connected`/reconnect signal; the Worker reacts).

## Dependencies

Internal:
- `FrameParser`, `FrameSizeError` from `src/infrastructure/server/protocol` — see [TCP Wire Protocol & Framing](./tcp-protocol.md). Used for `FrameParser.frame(...)` on write and incremental `addData(...)` on read.
- `SocketWriteQueue` from `src/infrastructure/server/socketWriteQueue.ts` — the
  same ordered short-write primitive used by the server response path.
- `safeTimeout` / `safeInterval` from `src/shared/timers.ts` and `assertDuration` from
  `src/shared/durations.ts` — see [Shared Timers & Durations](./shared-timers.md). Every
  timer this layer arms (command and Auth timeouts, the connect deadline, the reconnect
  backoff, the ping interval) goes through them, so no option value can reach a native
  timer as NaN, a negative number or more than 2^31 - 1 ms.
- Consumed by [Client SDK: Queue](./client-queue-sdk.md) (`queue.ts` wires `TcpConnectionPool` + `AddBatcher`), [Client SDK: Worker](./client-worker-sdk.md) (`worker.ts` creates a pool sized `min(concurrency, 8)` and subscribes via `onReconnect`), and [Store-and-Forward](./store-and-forward.md).

External / runtime:
- `Bun.connect` (TCP socket), `node:fs` `readFileSync` (TLS CA file, read into bytes), `Bun.hash` (pool key hashing).
- `msgpackr` — `pack` / `unpack` for the binary protocol.
- Node `events.EventEmitter` (base class for `TcpClient` and `ReconnectManager`).

## Public Interface

### Classes

`TcpConnectionPool` (`tcpPool.ts`) — pool of `TcpClient`s:
```typescript
constructor(options: PoolOptions = {})           // PoolOptions extends Partial<ConnectionOptions> + { poolSize?: number }
async connect(): Promise<void>                    // connect all clients in parallel
async send(command: Record<string, unknown>, options?: SendOptions): Promise<Record<string, unknown>>
reserveLongPoll(perConnection: number): LongPollLease | null  // { send(command, options?), release() } on one connection
async sendParallel(commands: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>>
onReconnect(cb: () => void): void                 // fires on every (re)connect of any pooled client
isConnected(): boolean
getConnectedCount(): number
getPoolSize(): number
addRef(): void                                    // shared-pool refcount
release(): void                                   // decrement; close() at zero
close(): void
isClosed(): boolean
getHealth(): { healthy; connectedCount; totalCount; clients: ConnectionHealth[]; avgLatencyMs; totalCommands; totalErrors }
```

Module functions (`tcpPool.ts`):
- `getSharedPool(options?: PoolOptions): TcpConnectionPool` — get-or-create a refcounted pool keyed by `getPoolKey` (`tcpPool.ts`, `tcp/poolKey.ts`). `getPoolKey` validates the options first (`assertPoolOptions`) and throws on an invalid one, so a rejected value never receives an existing pool.
- `releaseSharedPool(pool): void`, `closeAllSharedPools(): void`.

`TcpClient extends EventEmitter` (`tcp/client.ts:7`, through its runtime base classes) — single connection:
```typescript
constructor(options: Partial<ConnectionOptions> = {}) // throws TypeError/RangeError on an invalid option
async connect(): Promise<void>
async send(command: Record<string, unknown>, options?: SendOptions): Promise<Record<string, unknown>>
async hello(): Promise<HelloResponse>
async ping(): Promise<boolean>
close(): void
isConnected(): boolean
getState(): 'connected' | 'connecting' | 'disconnected' | 'closed'
getHealth(): ConnectionHealth
getInFlightCount(): number
```

`ReconnectManager extends EventEmitter` (`tcp/reconnect.ts`): `setClosed`, `isClosed`, `reset`, `cancelReconnect`, `canReconnect`, `scheduleReconnect(connectFn)`.

`HealthTracker` (`tcp/health.ts`): `recordSuccess`, `recordError`, `recordConnected`, `recordPingSuccess`, `recordPingFailure(): boolean`, `recordCommandTimeout(): boolean`, `getHealth(state)`, `startPing(fn)`, `stopPing`.

`CommandQueue` (`tcp/commandQueue.ts`): `enqueue`, `dequeue`, `remove(id)`, `addInFlight`, `removeByReqId`, `canSendMore(maxInFlight)`, `hasPending`, `getInFlightCount`, `rejectAll(error)`.

Option validation (`tcp/options.ts`), internal: `resolveConnectionOptions(owner, options)` validates, then fills every missing, `undefined` or `null` value from `DEFAULT_CONNECTION` (the `TcpClient` constructor, owner `TcpClient`); `assertConnectionOptions(owner, options)` only validates (`getSharedTcpClient`, before its key); `assertPoolOptions(owner, options)` adds `poolSize` (`getPoolKey`, owner `TcpConnectionPool`).

`AddBatcher<T>` (`queue/addBatcher.ts:44`):
```typescript
constructor(config: AddBatcherConfig, flushCb: FlushCallback<T>)
enqueue(name, data, opts?): Promise<Job<T>>
async flush(): Promise<void>
async waitForInFlight(): Promise<void>
stop(): void                                      // rejects remaining pending with "AddBatcher stopped"
hasPending(): boolean
```

`ClientClosedError extends Error` (`tcp/errors.ts:10`) — sentinel for the synthetic rejection issued by `close()`/`rejectAll()`. Its prototype carries the non-enumerable global brand `Symbol.for('bunqueue.ClientClosedError')` (`tcp/errors.ts:17`), so every bunqueue copy loaded in one process recognizes another copy's instances; a foreign error merely named `ClientClosedError` (e.g. undici's) does not carry it.

`installClientClosedFilter(): void` (`tcp/errors.ts:52-55`) — internal; installs the process `unhandledRejection` filter described under Edge cases unless a bunqueue filter is already registered.

Helpers: `createConnection(target, connectTimeout, events): Promise<ConnectionResult>` and `buildClientTls(tls)` (`tcp/transport.ts`). `getConnectionKey(owner, options)` and `getPoolKey(options)` (`tcp/poolKey.ts`) build the sharing keys.

`src/client/tcpClient.ts` is a deprecated re-export shim (`@deprecated Import from './tcp' instead`) that re-exports `TcpClient`, `getSharedTcpClient`, `closeSharedTcpClient`, `DEFAULT_CONNECTION`, and the `ConnectionOptions`/`ConnectionHealth` types. Shared single-client variants live in `tcp/shared.ts` (`getSharedTcpClient`, `closeSharedTcpClient`).

### TCP commands issued by this layer

- `Hello` — explicit protocol-version and capability negotiation via `hello()` (`tcp/runtime/commands.ts:10-21`).
- `Auth` — sent via `sendDirect` during `doConnect` when a `token` is configured (`tcp/runtime/connectivity.ts`).
- `Ping` — sent by the health timer and by the Worker heartbeat path.
- `SubscribeEvents` / `UnsubscribeEvents` — select or clear the one queue event
  stream associated with a dedicated connection.
- All other commands (`PUSH`, `PUSHB`, `PULL`, `ACK`, `FAIL`, queries, control, …) pass through opaquely as `Record<string, unknown>`; the transport adds a `reqId` field and reads `response.reqId`.

### Events emitted (`TcpClient`)

`connected`, `disconnected`, `reconnecting` (`{ attempt, delay }`), `maxReconnectAttemptsReached`, `error` (`Error`), `warning` (`{ type, reqId? }`; types `unknown_response`, `malformed_frame`), `health` (`{ type, latency?, reason? }`; types `ping_success`, `ping_failed`, `unhealthy`), and the internal typed `queueEvent` (`JobEvent`) consumed by `TcpEventSubscription`. `ReconnectManager` emits `reconnecting` and `maxReconnectAttemptsReached`.

## Data Models

Key shapes defined by this layer:

`ConnectionOptions` (`tcp/types/connection.ts:3-19`) with `DEFAULT_CONNECTION` (`tcp/types/connection.ts:34-50`): `host='localhost'`, `port=6789`, `token=''`, `tls=false`, `maxReconnectAttempts=Infinity`, `reconnectDelay=100`, `maxReconnectDelay=30000`, `connectTimeout=5000`, `commandTimeout=30000`, `autoReconnect=true`, `pingInterval=30000`, `maxPingFailures=3`, `maxCommandTimeouts=3`, `pipelining=true`, `maxInFlight=100`. The accepted values are listed under [Option validation](#option-validation).

`ClientTlsOptions` (`tcp/types/tls.ts:1-4`): `{ rejectUnauthorized?: boolean; caFile?: string }`. `tls` accepts `boolean | ClientTlsOptions`.

`PoolOptions` (`tcpPool.ts`) = `Partial<ConnectionOptions>` + `poolSize?` (default 4, floored to `>= 1`; `getSharedPool` requires a whole number).

`PendingCommand` (`tcp/types/command.ts`): `{ id, reqId, command, resolve, reject, timeout, timeoutMs?, promise? }`; `timeout` is the `SafeTimer` returned by `safeTimeout` (cancelled with `timeout.clear()`), `timeoutMs` is the command's own timeout.

`SendOptions` (`tcp/types/command.ts`): `{ timeout?: number }`. A positive finite `timeout` replaces `commandTimeout` for that command only (of any length: one above 2^31 - 1 ms is honoured, it no longer fires after ~1 ms); anything else keeps the connection default. Long-poll commands use it: the job wait sends `WaitJob` with its hold plus 5 s (`client/job-wait/brokerWait.ts`), so a deliberate hold the broker answers within that margin is never reported as `Command timeout` (see [Client SDK: Queue](./client-queue-sdk.md)).

`ConnectionHealth` (`tcp/types/connection.ts:21-32`): `{ healthy, state, lastSuccessAt, lastErrorAt, avgLatencyMs, consecutivePingFailures, consecutiveCommandTimeouts, totalCommands, totalErrors, uptimeMs }`.

`AutoBatchOptions` (`client/types/connection.ts:20-24`): `{ enabled?: boolean; maxSize?=50; maxDelayMs?=5 }`. `AddBatcherConfig` (`queue/addBatcher.ts:23-30`) adds `maxPending?` (default 10000).

## Business Logic / Control Flow

### Send path (pipelined)
1. `TcpConnectionPool.send` rejects if closed, else picks a client via `getNextClient` (`getNextClient`, `tcpPool.ts`): scans from `currentIndex` for the first `isConnected()` client (advancing `currentIndex`); if all are down it falls back to plain round-robin so the chosen client triggers its own reconnect.
2. `TcpClient.send` (`tcp/runtime/commands.ts`) assigns a monotonic `id` and a wrapped `reqId` (`generateReqId` masks to 31 bits, `tcp/runtime/health.ts`), enqueues the `PendingCommand` with its own timeout when `options.timeout` is set, then: if disconnected and not connecting it kicks off `connect().catch(()=>{})`; if connected it calls `processQueue`.
3. `processQueue` drains the command queue while `hasPending()` and
   `canSendMore(maxInFlight)`, (re)arms the timeout (the command's own
   `timeoutMs`, else `commandTimeout`) with `safeTimeout`, moves the command to
   in-flight, and frames it. `send` arms the queued-phase timeout the same way. Up to
   2^31 - 1 ms that is one native `setTimeout` plus a small wrapper (the hot path: no
   clock read, nothing else allocated); a longer timeout is armed in chunks and
   `Infinity` (no client-side deadline) arms nothing. `createConnection` sends the bytes through one
   `SocketWriteQueue` owned by that physical socket. A short write retains the
   exact tail; later frames wait behind it until Bun invokes `drain`.
4. On inbound data, the socket feeds bytes to `frameParser.addData(data)` and
   dispatches each complete frame to `handleData`. A validated `type:'event'`
   envelope emits `queueEvent` and returns immediately. Every other frame
   follows request correlation: match `response.reqId` against in-flight,
   clear its timeout, resolve, and re-run `processQueue` to send more.

### Dedicated event subscription

`TcpEventSubscription` owns one `TcpClient` and one queue key. It resolves the
same token and connection defaults as the queue/worker transport, connects and
authenticates first, sends `SubscribeEvents`, and reports ready only after the
acknowledgement. A disconnect invalidates the current generation; the client's
normal reconnect emits `connected`, which starts exactly one fresh subscription
attempt. Every successful subscription after the first calls the optional
`onResubscribed` callback: events the broker sent while the connection was down
are lost, so `QueueEvents` turns it into an internal `resubscribed` signal
(`queue-events/streamSignals.ts`) on which job waits re-read their job.
`close()` invalidates pending work and closes the socket, so no event can be
delivered after teardown.

### Connect path
`connect` (`tcp/runtime/connectivity.ts`) takes a new `generation` and calls `doConnect`, which calls `createConnection` (msgpack over `Bun.connect`, TLS via `buildClientTls`; the `connectTimeout` deadline is a `safeTimeout` armed before the socket opens, and a synchronous `Bun.connect` refusal such as an out-of-range port clears it and rejects with that error), enables TCP keepalive (`setKeepAlive(true, 15000)`, best-effort), authenticates via `sendDirect({cmd:'Auth'})` when a token is set, then marks connected and `recordConnected()`. `connect` then resets the reconnect counter, emits `connected`, starts the ping timer (`HealthTracker.startPing`: a `safeInterval`; `pingInterval` 0 or `Infinity` arms nothing), and flushes the queue, unless a `connected` listener closed the client. Concurrent `connect()` calls dedupe through `waitForConnection`, which `close()` rejects with `ClientClosedError`.

### Connection ownership

`generation` (`tcp/runtime/state.ts`) names the current socket. It is bumped when an attempt starts, by `close()`, and by `forceReconnect()`, and every socket event is bound to the generation of its attempt: `onData`, `onClose` and `onError` of a retired socket are ignored. Before, the lost-connection path ran for whatever connection was current, so a timed-out socket's late close dropped the healthy newer connection (its socket leaked, still open), emitted `disconnected` and opened a third connection (`test/repro-tcp-client-stale-socket.test.ts`).

- **`close()` wins.** It bumps the generation, rejects queued and in-flight commands and every `connect()` waiter with `ClientClosedError`, cancels the reconnect and ends the socket. An attempt still in flight closes its socket when `createConnection` resolves (or after Auth) and rejects with `ClientClosedError` without touching the client's state; a `connected` listener that closes the client stops the ping and queue flush. Before, the attempt finished after `close()`: `getState()` said `closed` while `isConnected()` was true, the socket stayed open, the ping ran, and close during Auth hung the waiter (`test/repro-tcp-client-close-during-connect.test.ts`). A later `connect()` or `send()` opens a fresh connection, as before.
- **A retired attempt touches nothing.** Whoever bumped the generation (`close()`, `forceReconnect()`, a newer attempt) owns `connecting` and the reconnect schedule; the retired attempt only closes its socket and rejects (`ClientClosedError` after `close()`, `Connection lost` after a forced reconnect). `handleClose` therefore no longer resets `connecting`: an attempt in flight resets it itself when it fails.
- **Transport events of a failed attempt** (`ConnectionEvents`, `tcp/transport.ts`): a timed-out attempt terminates its socket, a socket that opens after its attempt failed is terminated at once, and a failed attempt never reports data or errors. Its close is reported only when its TCP connection opened while the attempt was pending (a TLS rejection or a TLS handshake that timed out), as before and as in the portable transport; a refused or abandoned attempt only fails, so the queued commands wait for the next attempt (`test/tcp-parity-transport.test.ts`, `test/tcp-parity-timers.test.ts`).

### TLS server-certificate verification (#109)

`Bun.connect` does **not** reject an unauthorized peer on the client side — it completes the socket regardless of `ca`/`rejectUnauthorized`. It does, however, compute the peer's authorization result and pass it to the `handshake(socket, success, authorizationError)` callback. `createConnection` enforces it there: `tlsRequiresVerification` (`tcp/transport.ts`) treats verification as the default for any TLS connection and only an explicit `rejectUnauthorized: false` opts out (encryption-only). On a required-verification connection a non-null `authorizationError` (wrong/absent CA, self-signed, hostname mismatch) closes the socket and rejects with `TLS verification failed: <reason>`; otherwise the connection resolves (`handshake` in `tcp/transport.ts`).

Two ordering facts drive the implementation: (1) `buildClientTls` reads `caFile` into **bytes** (`readFileSync`) rather than passing a `Bun.file` handle, so Bun computes `authorizationError` against the pinned CA; (2) once a `handshake` handler is registered, Bun fires `open` **before** the TLS handshake completes (without one, `open` fires only after). So for every TLS connection the resolve is gated on `handshake`, not `open` — resolving in `open` would let the pool write its first command onto a socket whose handshake is still in flight and lose the bytes. Plaintext has no handshake event and still resolves in `open`.

### Reconnect path
On close/error/forced teardown, `scheduleReconnect` (`reconnect.ts:95`) increments `reconnectAttempts`, emits `maxReconnectAttemptsReached` (and stops) once it exceeds `maxReconnectAttempts`, else computes `baseDelay = min(reconnectDelay * 2^min(attempt-1, 1023), maxReconnectDelay)` plus `Math.random()*0.3*baseDelay` jitter, capped at `Number.MAX_VALUE` (`backoffDelay`, `reconnect.ts:26`), arms a single `safeTimeout` (guards against double-scheduling via `reconnectTimer`/`closed`), then emits `reconnecting`. The timer is armed first so that a `reconnecting` listener that closes the client cancels it; before, the timer was armed after the event and the client reconnected although it had been closed (`test/repro-tcp-client-close-in-reconnecting.test.ts`). The capped exponent keeps the factor finite: past attempt 1024 a 0 base no longer gives `0 * Infinity = NaN`, an overflowing product is cut to the ceiling, and the jittered delay is always finite. A backoff above 2^31 - 1 ms waits its full length instead of retrying after ~1 ms.

### Half-open detection (#94)
A dead peer with no FIN/RST leaves writes succeeding while no response returns. Two recovery signals: (a) ping failures — `handlePingFailure` (`tcp/runtime/health.ts`) forces reconnect once `recordPingFailure()` hits `maxPingFailures`; (b) command timeouts — `handleCommandTimeout` (`tcp/runtime/health.ts`) forces reconnect once `recordCommandTimeout()` hits `maxCommandTimeouts` (default 3, 0 disables). Any successful command or ping resets the consecutive-timeout counter (`HealthTracker.recordSuccess`, `HealthTracker.recordPingSuccess`), so it only fires on a sustained run. `forceReconnect` (`tcp/runtime/health.ts`) tears down the socket (swallowing `end()` errors), `rejectAll`s in-flight commands immediately (preventing stale timeouts from re-triggering a reconnect storm), and reschedules.

### Auto-batch path
`Queue.add` routes through `AddBatcher.enqueue` unless `opts.durable` is set or the batcher is disabled (`queue/runtime/queries.ts:10-15`). `enqueue` (`queue/addBatcher.ts:61-91`) pushes the entry, then: flush immediately if `pending.length >= maxSize`; **also** flush immediately if no flush is in-flight (`!this.flushing`) — this gives sequential `await`ed adds zero added latency; otherwise arm a `maxDelayMs` timer so concurrent adds coalesce. `doFlush` (`queue/addBatcher.ts:108-119`) loops `flushOnce` until the buffer drains, so items arriving during a flush are batched into the next round-trip. `flushOnce` (`queue/addBatcher.ts:127-150`) splices the whole buffer, calls `flushCb` (which invokes `addBulk` → `PUSHB`), and fan-out-resolves/rejects each caller by index.

## Concurrency & Locking

No mutexes — single-threaded JS event loop. Concurrency is managed by:
- **Pipelining window**: `maxInFlight` (default 100) bounds simultaneously outstanding commands per `TcpClient`; `processQueue` stops dequeuing when the window is full and resumes as responses arrive.
- **Byte-order gate**: the connection-local write queue serializes partially
  written frame tails ahead of every later frame. It is cleared on explicit
  close or disconnect and is never inherited by a replacement socket.
- **reqId correlation**: responses are matched by `reqId` (`inFlightByReqId` map), so out-of-order responses across pipelined commands are handled correctly; a legacy single-command fallback exists in `handleData` (`tcp/runtime/health.ts`).
- **Connect dedupe**: the `connecting` flag + `waitForConnection` ensure overlapping `connect()` calls share one attempt.
- **Reconnect single-flight**: `scheduleReconnect` no-ops if a timer is already armed or the manager is closed.
- **Batcher flush serialization**: the `flushing` flag plus `inFlightFlushes` set ensure only one flush loop runs at a time; `disconnect()` awaits `flush()` and `waitForInFlight()` before stopping the batcher (`queue/runtime/connection.ts:5-12`).
- **Shared-pool refcounting**: `addRef`/`release` (`tcpPool.ts`) — the pool closes only when the count hits zero; `getSharedPool` removes a closed pool from the map before recreating. Each Queue records whether it has released its constructor-owned reference, so repeated `close()` calls and `disconnect()` followed by `close()` cannot decrement the same ownership twice or close a peer Queue's pool.

## Edge Cases & Failure Modes

- **Malformed frame**: `handleData` catch (`tcp/runtime/health.ts`) treats the framed stream as unrecoverable — emits `warning {malformed_frame}`, `rejectAll`s every pending/in-flight command (so they don't hang until per-command timeout), and `forceReconnect`s for a clean stream.
- **Malformed event envelope**: an unsolicited frame must contain a finite
  timestamp and string `eventType`, `queue`, and `jobId`. An invalid envelope is
  treated as a malformed stream and reconnects; it never falls through to the
  legacy current-command response slot.
- **Frame too large**: `FrameSizeError` from `addData` surfaces as an `error` event (`tcp/transport.ts`) and the read returns without dispatching.
- **Command timeout taxonomy** (`tcp/runtime/commands.ts`): a still-queued command (never written) is rejected but does NOT count toward dead-link detection; an in-flight command that got no response rejects AND calls `handleCommandTimeout`. A command with its own timeout is measured against that timeout in both phases, so a long-poll command the broker answers in time never counts toward dead-link detection (`test/tcp-client-command-timeout.test.ts`). The broker still runs at most 50 commands per connection at once (`MAX_CONCURRENT_PER_CONNECTION`): long-poll commands occupy those slots for their whole hold, and commands queued behind them on the broker can overrun their own timeout. The job wait therefore leases its `WaitJob` holds per connection through `TcpConnectionPool.reserveLongPoll(perConnection)` (`tcp/longPollRouter.ts`): a lease goes to the connection with the fewest (a connected one on a tie; an idle connection connects for it), and only while that connection has fewer than `perConnection` (the wait asks for 40) and fewer than half of its `maxInFlight` window, so every connection keeps room for ordinary commands on both the broker and the client (`client/job-wait/holdLimiter.ts`). A pool splits ordinary commands round-robin over its connected clients; other long-poll commands (`PULL`/`PULLB` with a `timeout`, the MCP backend's `wait_for_job`) are not covered by that cap.
- **Connection lost / close**: `handleClose` (`tcp/runtime/health.ts`) runs only for the current socket; it rejects all in-flight with `Connection lost` and reconnects only if it was previously connected and `canReconnect()`.
- **Outbound short write**: Bun TCP writes are unbuffered and may accept fewer
  bytes than supplied. The accepted prefix is not resent; the remaining tail
  is queued and flushed on `drain`. A closed/throwing socket or a client queue
  above 64 MiB is terminated so pending commands reject instead of waiting for
  a corrupted response stream.
- **Intentional close idempotency / unhandled-rejection safety**: `close` (`tcp/runtime/lifecycle.ts`) retires the generation, sets closed, stops ping, cancels reconnect, installs the synthetic-close rejection filter (`installClientClosedFilter`, `tcp/errors.ts:36-55`), and `rejectAll`s with `ClientClosedError`. `rejectAll` attaches a silent `.catch` to each `cmd.promise` before rejecting (`CommandQueue.rejectAll`) so fire-and-forget callers (heartbeats, polling loops) don't surface unhandled rejections; the filter covers derived chains further down whose handler is missing.
- **Close filter must not swallow host rejections**: registering any `unhandledRejection` listener disables the Bun/Node default (print the error, exit 1). The filter therefore: (1) returns for a `ClientClosedError`, identified by `instanceof` or the global brand; (2) returns when any non-bunqueue `unhandledRejection` listener is registered, because that listener owns the rejection and receives it exactly once; (3) otherwise removes itself and re-raises the reason with `Promise.reject(reason)`, so the runtime's configured mode applies (default: crash with exit 1; `--unhandled-rejections=warn`: warning and the process keeps running). The filter function carries `Symbol.for('bunqueue.clientClosedRejectionFilter')`; installation is skipped while any branded filter is registered and is decided from `process.listeners('unhandledRejection')` rather than a module flag, so duplicate bunqueue copies in one process share one filter (two filters would each defer to the other and swallow host rejections again) and the next `close()` re-installs it after it stepped aside or after the host removed all listeners. Before this change, the filter did nothing for foreign reasons and silently swallowed every application rejection (exit 0, no output) after the first TCP client close. Regression: `test/repro-client-closed-filter-swallows-app-rejections.test.ts`.
- **Close filter residuals**: after the filter steps aside, a later leaked `ClientClosedError` from an already-closed client is unfiltered until the next `close()` re-installs it. In `--unhandled-rejections=warn` mode (Bun and Node) the runtime warns about the original rejection even with a listener, so the re-raise prints a second warning. In `--unhandled-rejections=strict` mode the runtime raises the original as an uncaught exception first, so a host `uncaughtException` handler sees the same reason twice. Bun reports a timer-originated rejection immediately but may exit on the next event-loop wakeup; that is the runtime default, with or without the filter.
- **Max reconnect attempts reached**: `TcpClientState` rejects all queued commands with `Max reconnection attempts reached` when the reconnect manager emits its terminal event (`tcp/runtime/state.ts`).
- **TLS connect failure**: `Bun.connect` may reject (handshake refused) instead of firing `connectError`; the rejection handler of `Bun.connect` in `createConnection` (`tcp/transport.ts`) routes it to the same rejection so callers never hang past `connectTimeout`.
- **Socket error listener**: `TcpConnectionPool` attaches a no-op `error` listener to each client (`tcpPool.ts`) so an EventEmitter `error` (e.g. TLS handshake garbage) never crashes the process.
- **Durable bypass**: `durable` jobs skip the batcher and go out as individual `PUSH` (`queue/runtime/queries.ts:10-15`); `Store-and-Forward` disables auto-batch entirely (`forwarder.ts: autoBatch:{enabled:false}`).
- **Batcher overflow**: at `maxPending` (10000) `enqueue` drops and rejects the oldest 10% with `Add buffer overflow - oldest entries dropped` (`queue/addBatcher.ts:68-74`).
- **Batcher stop**: `stop()` rejects all remaining pending with `AddBatcher stopped`; `enqueue` after stop rejects immediately.
- **Memory bound**: `HealthTracker` keeps only the last 10 latencies (`MAX_LATENCY_HISTORY`, `tcp/health.ts`) for the rolling average.
- **reqId wrap**: counter masks to `0x7fffffff` (`generateReqId`, `tcp/runtime/health.ts`); collisions across a 2^31 window of simultaneously in-flight commands are not defended against (impractical given `maxInFlight`).
- **Pool degraded mode**: when every client is disconnected, `getNextClient` still returns one (round-robin) so the send attempt drives reconnection rather than failing fast.
- **Invalid option values**: rejected at construction (see [Option validation](#option-validation)). Before, a NaN, negative, sub-millisecond, too-large or explicitly `undefined` duration reached a native timer and ran after ~1 ms: every connection sent the broker hundreds of Pings per second, a down broker got a reconnect attempt every millisecond, and every command or connection attempt failed with `Command timeout` / `Connection timeout` at once (`test/repro-tcp-client-*.test.ts`).
- **Long-poll holds need `maxInFlight >= 2`**: `reserveLongPoll` grants at most half of a connection's `maxInFlight`, so with `maxInFlight: 1` no `WaitJob` hold is ever granted and a job wait on that pool settles through its state reads only (1 s, 2 s, 4 s ... then every 30 s). This is deliberate: a hold would take the only in-flight slot for up to 35 s. Ordinary commands are unaffected.

## Configuration

All knobs come through `ConnectionOptions` / `PoolOptions` (programmatic; no env vars are read directly in this layer). Defaults from `DEFAULT_CONNECTION` (`tcp/types/connection.ts:34-50`):

| Option | Default | Effect |
| --- | --- | --- |
| `host` / `port` | `localhost` / `6789` | server target; a non-blank string / a whole number from 1 to 65535 |
| `token` | `''` | sends `Auth` on connect when set; a falsy non-string (`false`, `0`) means no token, as on 2.9.10 |
| `tls` | `false` | `true` = system CAs; object = `{caFile, rejectUnauthorized}` |
| `poolSize` | 4 (Queue); `min(concurrency, 8)` (Worker) | clients per pool; below 1 (`-Infinity` included) means 1 and a fraction rounds up (2.5 builds 3, as on 2.9.10); NaN, `Infinity` and values above 65535 throw |
| `maxReconnectAttempts` | `Infinity` | cap before `maxReconnectAttemptsReached`; ≥ 0 (0 = no reconnect; a negative value is 0, a fraction rounds down) or `Infinity` (NaN and values above `Number.MAX_SAFE_INTEGER` too) |
| `reconnectDelay` / `maxReconnectDelay` | 100 / 30000 ms | backoff base / ceiling; base > 0 ms (below 1 ms still doubles) or `Infinity` (always the ceiling); ceiling ≥ 1 ms or `Infinity` (uncapped growth) |
| `connectTimeout` | 5000 ms | per-connect deadline; finite, ≥ 1 ms |
| `commandTimeout` | 30000 ms | per-command deadline, unless `send(command, { timeout })` gives the command its own; ≥ 1 ms, or `Infinity` (no client-side deadline) |
| `autoReconnect` | `true` | enable reconnection |
| `pingInterval` | 30000 ms (0 = off) | health ping cadence; 0, a negative value or `Infinity` = off, otherwise ≥ 1 ms |
| `maxPingFailures` | 3 | consecutive ping fails → reconnect; > 0 (a fraction rounds up) or `Infinity` (never; also above `Number.MAX_SAFE_INTEGER`) |
| `maxCommandTimeouts` | 3 (0 = off) | consecutive timeouts → reconnect (#94); ≥ 0 (a negative value or NaN is 0, a fraction rounds up) or `Infinity` (never) |
| `pipelining` | `true` | forwarded by the pool, but not read by the send path (see caveat below) |
| `maxInFlight` | 100 | pipelining window per `TcpClient` (forwarded by the pool); > 0 (a fraction rounds up) or `Infinity` (also above `Number.MAX_SAFE_INTEGER`) |
| `autoBatch.maxSize` / `maxDelayMs` / `enabled` | 50 / 5 ms / true (TCP) | `add()` coalescing; see [Client SDK: Queue](./client-queue-sdk.md) for the accepted values |
| `autoBatch.maxPending` | 10000 | batcher overflow bound |

Caveat: the `pipelining` flag is declared, defaulted, and forwarded, but never read by `TcpClient` (the reqId send path is unconditional, so pipelining is effectively always on). `TcpConnectionPool` resolves every connection option through `resolveConnectionOptions` (the one defaults table, `DEFAULT_CONNECTION`) and hands the whole resolved object to each `TcpClient` it constructs, so no option, `maxInFlight` and `pipelining` included, can be dropped on the way (#111).

Shared pools are reused only when `poolSize === 4 && !token` for a Queue (`queue/runtime/state.ts`); otherwise a dedicated pool is created (a `SandboxedWorker` always uses `getSharedPool`, token included). The pool key (`getPoolKey`) is the normalized `poolSize` (`resolvePoolSize`) plus `getConnectionKey`, which `getSharedTcpClient` uses alone: every option in `DEFAULT_CONNECTION`, resolved and normalized (so missing, `undefined`, `null` and the explicit default are the same, and so are `port: '6789'` and `port: 6789`), with the token as its full 64-bit hash (never the token itself) and TLS as the two fields the transport reads (`caFile`, `rejectUnauthorized`, in a fixed order). A caller therefore only ever receives a pool or client built from options equal to its own. Before, the key covered host, port, poolSize, TLS, `pipelining`/`maxInFlight` and a 16-bit token fingerprint: a later caller with other timeouts, ping or reconnect settings silently got the first caller's, and the fingerprint (`Number(Bun.hash(token)) & 0xffff`, which rounds the hash to a double before masking) took about 1,900 values, so `token-10` and `token-12` shared a pool and the second ran its commands under the first one's identity (`test/repro-tcp-client-shared-key.test.ts`). Including every option was chosen over keeping the old key and warning: two callers that need different timeouts cannot share connections correctly, and callers that pass equal options still share exactly as before. Queues with different timeouts now hold separate pools, so more connections.

### Option validation

Every numeric option, and the target (`host`, `port`, `token`), is checked where it enters (`tcp/options.ts`):

- the `TcpClient` constructor (`resolveConnectionOptions`, owner `TcpClient`). This also covers each connection a `TcpConnectionPool` builds and the dedicated `TcpEventSubscription` connection of `QueueEvents` and of a TCP Worker's `stalled` subscription;
- `getSharedPool`, through `getPoolKey` (owner `TcpConnectionPool`), before the key is computed, so a rejected value never receives an existing pool, and no NaN or Infinity can shape a key;
- `getSharedTcpClient`, before its key.

Before validation, `normalizeConnectionOptions` (`tcp/options.ts`) rewrites every value 2.9.10 read with a well-defined result to that result, so code that worked on 2.9.10 keeps working: a numeric string of plain decimal digits (`port: process.env.PORT`) is that number (`coerceNumericString`, `tcp/numeric.ts`; 2.9.10's comparisons and Bun's socket and timer APIs coerced it), the counts and `pingInterval` follow 2.9.10's comparisons (`pingInterval <= 0` disabled the ping, `attempt > maxReconnectAttempts` with NaN never stopping, `timeouts >= maxCommandTimeouts` with `<= 0` disabling it and NaN never firing, `failures >= maxPingFailures`, `inFlight < maxInFlight`, `i < poolSize`), a count above `Number.MAX_SAFE_INTEGER` is no limit (`Infinity`), and a falsy non-string `token` is no token (2.9.10's `if (token)` skipped `Auth`). The same normalized values feed validation, the resolved options and both sharing keys. A non-number (any other string included) throws a `TypeError`, any other rejected value a `RangeError`; both name the owner and the option, e.g. `TcpClient: pingInterval must be a finite number of milliseconds >= 0 or Infinity (got NaN)`, `TcpClient: maxInFlight must be a whole number >= 1 or Infinity (got 0)`, `TcpConnectionPool: poolSize must be a whole number <= 65535 (got NaN)`. `undefined` and `null` mean the default (the pool resolves them with `??`; a `TcpClient` used to let them replace the default). Durations have no upper bound: one above 2^31 - 1 ms (about 24.8 days) is honoured exactly by the shared timers.

| Option | Accepted | Why the bound |
| --- | --- | --- |
| `host` | a non-blank string | Bun refuses an empty host only when it connects (`Expected either "hostname" or "unix"`), and a blank or non-string one fails every attempt; the reconnect loop then retried forever with Bun's message |
| `port` | whole number from 1 to 65535, or its decimal string (`'6789'`, as `process.env.PORT` gives it) | port 0 cannot be connected to and TCP ports end at 65535; NaN, a fraction or an out-of-range port failed only when connecting (`SocketOptions.port must be ...`). A decimal string connected on 2.9.10 and still does; any other string throws |
| `token` | a string (`''` = no Auth); `false` or `0` = no Auth | a truthy non-string token was sent as is and broke the sharing key's hash |
| `connectTimeout` | finite, ≥ 1 ms | below 1 ms the runtime arms 1 ms; 0 fires before a connection can open; with `Infinity` an attempt could never end (a TLS handshake a peer never answers stays pending) |
| `commandTimeout` | ≥ 1 ms or `Infinity` | 0 times every command out before its reply |
| `pingInterval` | 0, ≥ 1 ms, or `Infinity`; a negative value is 0 | 0, a negative value and `Infinity` mean no ping; between 0 and 1 ms, or NaN, the interval would tick every ~1 ms |
| `reconnectDelay`, `maxReconnectDelay` | base > 0 ms or `Infinity`; ceiling ≥ 1 ms or `Infinity` | a 0 base never grows (0 × 2^n = 0) and a 0 ceiling caps every delay at 0: a hot reconnect loop against a down broker. A base below 1 ms still doubles (2.9.10 retried once after ~1 ms, then grew); an infinite base waits the ceiling every time; an infinite ceiling leaves the growth uncapped (2.9.10's timer overflowed to ~1 ms after about 25 attempts, `safeTimeout` now honours it) |
| `maxReconnectAttempts` | whole number ≥ 0 or `Infinity`; a negative value is 0, a fraction rounds down (2.5 makes 2 attempts), NaN or a count above `Number.MAX_SAFE_INTEGER` is `Infinity` | 0 gives up when the connection is lost |
| `maxPingFailures` | whole number ≥ 1 or `Infinity`; a positive fraction rounds up | 0 would leave `getHealth().healthy` false forever |
| `maxCommandTimeouts` | whole number ≥ 0 or `Infinity`; a negative value or NaN is 0, a fraction rounds up | 0 (or `Infinity`) disables the timeout-driven reconnect |
| `maxInFlight` | whole number ≥ 1 or `Infinity`; a positive fraction rounds up (2.5 allows 3) | 0 would never send a command |
| `poolSize` | number ≤ 65535 | below 1 means one connection and a fraction rounds up (2.5 builds 3, as 2.9.10's `i < poolSize` loop did); NaN builds no connection and throws; 65535 is the number of TCP connections one client address can hold to one broker address (one per local port), and it stops a typo such as `1e9` from building a billion clients until the process runs out of memory |

A direct `new TcpConnectionPool(options)` validates first (`assertPoolOptions`, owner `TcpConnectionPool`), `poolSize` included; before, it validated only through its first `TcpClient` (errors named `TcpClient:`), a `NaN` `poolSize` built a pool without connections and an infinite one looped until the process ran out of memory. Counts use `assertInteger` from `src/shared/durations.ts`. The MCP TCP backend parses `BUNQUEUE_PORT` and `BUNQUEUE_POOL_SIZE` against the same bounds with the shared `parseIntegerEnv` (`src/mcp/backend/tcp/env.ts`, [MCP Server](./mcp-server.md)); `BUNQUEUE_PORT` was read with `parseInt`, so `6789abc` connected to 6789 and `abc` reached the pool as NaN. Tests: `test/tcp-client-option-validation.test.ts` (every accepted and rejected value, messages, `undefined`/`null` defaults, key normalization), `test/tcp-client-sdk-option-validation.test.ts` (`Queue` on the shared and on a dedicated pool, `Worker`, `FlowProducer`, `QueueEvents` and `SandboxedWorker` all throw at construction) and `test/repro-tcp-client-{ping-interval,reconnect-storm,command-timeout,connect-timeout,pool-options,target-options,mcp-pool-size,mcp-broker-env}.test.ts` (each defect, observed on a real socket against a broker double from `test/tcp-client-support.ts`, which also asserts that no out-of-range delay reaches a native timer). `test/repro-compat-client-connection.test.ts` covers the 2.9.10 results kept by normalization (a numeric-string port through every SDK class, `getSharedPool` sharing `'6789'` with `6789`, fractional and negative counts, a negative `pingInterval`) and the values that still throw.

## Related Docs

- [Client SDK: Queue](./client-queue-sdk.md) — wires the pool + `AddBatcher` and routes `add()`.
- [Client SDK: Worker (& sandboxed)](./client-worker-sdk.md) — pool sizing, `onReconnect` re-registration.
- [TCP Wire Protocol & Framing](./tcp-protocol.md) — `FrameParser`, msgpack framing.
- [TCP Server Command Handlers](./tcp-server-handlers.md) — server side of these commands.
- [Security: TLS, Auth, CORS](./security-tls-auth.md) — `Auth` command, TLS server config.
- [Store-and-Forward & BullMQ Compatibility](./store-and-forward.md) — edge→central forwarding over this transport.
- [Job Lifecycle (push / pull / ack / fail)](./job-lifecycle.md) — command semantics.
