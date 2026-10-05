---
title: 'TCP Protocol Architecture: Wire Format & Pipelining'
description: 'bunqueue TCP protocol deep dive: MessagePack wire format, pipelining, connection pooling, and binary command architecture.'
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/architecture/tcp-protocol.png
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">architecture · tcp protocol</span>
  <h1 class="bq-hero-h1 bq-bench-h1">Frames on the <em>wire.</em></h1>
  <p class="bq-hero-sub">bunqueue uses a high-performance binary protocol over TCP with MessagePack serialization and optional pipelining. This page covers the wire format, connection lifecycle, and command set.</p>
</div>

## Wire Format

Each message is a **length-prefixed MessagePack frame**:

| Bytes | Content                                   |
| ----- | ----------------------------------------- |
| 0-3   | Frame length (4 bytes, big-endian uint32) |
| 4-N   | MessagePack payload                       |

**Maximum frame size:** 64 MB

Both directions preserve frame ordering under socket backpressure. Bun's TCP
write is unbuffered and may accept only a prefix, so the reference client and
server retain the exact unwritten tail and place later frames behind it until
`drain`. Each queue belongs to one physical socket and is discarded on close;
commands are never blindly replayed after reconnect because the broker may
already have applied them.

## TCP Pipelining

Pipelining allows multiple commands to be sent without waiting for responses, dramatically improving throughput.

### Without Pipelining (Sequential)

```
Client                    Server
  │── PUSH job1 ────────────>│
  │<── { ok, id } ───────────│  wait ~1ms
  │── PUSH job2 ────────────>│
  │<── { ok, id } ───────────│  wait ~1ms
  │── PUSH job3 ────────────>│
  │<── { ok, id } ───────────│  wait ~1ms

  Total: 3 round-trips ≈ 3ms
  Throughput: ~1,000 ops/sec (one command per 1ms round-trip)
```

### With Pipelining (Parallel)

```
Client                    Server
  │── PUSH job1 (reqId:1) ──>│
  │── PUSH job2 (reqId:2) ──>│  no wait
  │── PUSH job3 (reqId:3) ──>│  no wait
  │<── { ok, reqId:1 } ──────│
  │<── { ok, reqId:2 } ──────│
  │<── { ok, reqId:3 } ──────│

  Total: 1 round-trip ≈ 1ms
  Throughput: ~3,000 ops/sec (three commands per 1ms round-trip)
```

**Result: 3x faster in this illustrative 1 ms example.** Real throughput depends
on latency, connection count, batching, durability, database size, and storage
backend. The [current benchmark page](/guide/benchmarks/) publishes measured
workloads instead of treating this round-trip sketch as a capacity claim.

### How Pipelining Works

1. **Client sends commands** with unique `reqId` identifiers
2. **Server processes in parallel** (up to 50 concurrent per connection)
3. **Responses include `reqId`** for matching (may arrive out of order)
4. **Client matches responses** using a `Map<reqId, Promise>`

### Configuration

```typescript
const queue = new Queue('my-queue', {
  connection: {
    host: 'localhost',
    port: 6789,
    pipelining: true, // Enable pipelining (default: true)
    maxInFlight: 100, // Max concurrent commands (default: 100)
    poolSize: 32, // Connection pool size
    commandTimeout: 30000, // Timeout per command (ms)
    pingInterval: 30000, // Health-check ping interval (ms, 0 disables)
    maxCommandTimeouts: 3, // Consecutive command timeouts → reconnect (0 disables)
  },
});
```

| Option               | Default | Description                                                                                                                                       |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipelining`         | `true`  | Enable TCP pipelining                                                                                                                             |
| `maxInFlight`        | `100`   | Max commands in flight per connection (a whole number `>= 1`, or `Infinity`)                                                                      |
| `poolSize`           | `4`     | Number of TCP connections (a whole number up to 65535; below 1 means one)                                                                         |
| `commandTimeout`     | `30000` | Command timeout (ms, `>= 1`; `Infinity` = no client-side timeout)                                                                                 |
| `pingInterval`       | `30000` | Health-check ping interval (ms; `0` or `Infinity` disables, otherwise `>= 1`)                                                                     |
| `maxCommandTimeouts` | `3`     | Consecutive command timeouts (no intervening success) before the link is concluded dead and reconnect is forced (a whole number; `0` disables) |

The timeout, interval and in-flight values, and `host` (a non-blank string) and `port`
(a whole number from 1 to 65535), are checked when the `Queue`, `Worker`,
`FlowProducer`, `QueueEvents` or `SandboxedWorker` is constructed. A value that is not
a number throws a `TypeError`; NaN, a negative value, a fraction of a millisecond or a
fractional count throws a `RangeError` naming the option, for example
`TcpClient: pingInterval must be a finite number of milliseconds >= 0 or Infinity (got NaN)`.
`undefined` or `null` keeps the default. Durations have no upper bound: a value above
2^31 - 1 ms (about 24.8 days) is honoured exactly instead of firing after about 1 ms.

## Protocol Version Negotiation

On connect, client and server negotiate protocol version:

```typescript
// Client → Server
{ cmd: 'Hello', protocolVersion: 3, capabilities: ['pipelining', 'separate-job-name'] }

// Server → Client
{ ok: true, protocolVersion: 3, capabilities: ['pipelining', 'separate-job-name'], server: 'bunqueue', version: '2.x.y' }
```

Protocol v3 supports pipelining and a separate top-level job `name`, leaving
the user-owned `data` value unchanged. The server accepts clients that omit
`Hello`; legacy job input without top-level `name` is decoded only at the
inbound protocol boundary.

## Connection Lifecycle

**States:**

1. **DISCONNECTED** → Initial state
2. **CONNECTING** → Socket.connect() in progress
3. **CONNECTED** → Ready for commands
4. **RECONNECTING** → Auto-reconnect with backoff

**Connect sequence:**

1. TCP socket connect
2. Send `Hello` (protocol negotiation)
3. Send `Auth` (if token configured)
4. Start ping timer
5. Ready for commands

**Reconnect strategy:**

- Base delay: 100ms (`reconnectDelay`)
- Max delay: 30s (`maxReconnectDelay`)
- Closing the client always wins: `close()` during a connect attempt closes that
  socket and rejects the attempt with `ClientClosedError`, and `close()` from a
  `reconnecting` listener cancels the retry
- A connection attempt that times out closes its socket, and a superseded socket's
  late events never affect the current connection
- Backoff: exponential (2x each attempt)
- Jitter: additive, up to +30% of the computed delay

**Dead-link detection (half-open sockets):**

A socket can go **half-open**, the peer vanishes with no FIN/RST (suspended host,
NAT/load-balancer silently dropping an idle connection). Writes still succeed and no
`close`/`error` event fires, so the client must detect it actively. Two independent
signals conclude the link is dead and trigger `forceReconnect()`:

1. **Health-check ping**, after `maxPingFailures` (3) consecutive failed pings.
2. **Command timeouts**, after `maxCommandTimeouts` (3) consecutive command timeouts
   with no intervening success. This is the path that recovers a worker whose `PULL`s
   keep timing out, without waiting for the slower ping cycle (and it works even when the
   ping is disabled). The counter resets on any successful response.

On detection the socket is torn down, all in-flight commands are rejected immediately
(`Connection lost`) so callers unblock at once, and the reconnect/backoff loop above
re-establishes a fresh connection. `SO_KEEPALIVE` is also enabled so the OS can surface a
dead peer on its own rather than lingering until `tcp_retries2` (~15 min).

For _fast_ recovery, lower `pingInterval` / `commandTimeout`, e.g.
`{ pingInterval: 10000, commandTimeout: 5000 }` recovers in ~tens of seconds vs ~120s on
defaults (each default timeout is 30s, so timeout-based detection is inherently coarse).

## Authentication

If `AUTH_TOKENS` is configured on the server, clients must authenticate:

```typescript
// Client → Server
{ cmd: 'Auth', token: 'your-secret-token' }

// Server → Client
{ ok: true }  // or { ok: false, error: 'Invalid token' }
```

Token comparison uses constant-time algorithm to prevent timing attacks.

## Commands Reference

### Core Commands

| Command | Description    | Request                                   | Response                                        |
| ------- | -------------- | ----------------------------------------- | ----------------------------------------------- |
| `PUSH`  | Add single job | `{ cmd, queue, data, priority?, delay? }` | `{ ok, id }`                                    |
| `PUSHB` | Add batch      | `{ cmd, queue, jobs }`                    | `{ ok, ids }`                                   |
| `PULL`  | Get single job | `{ cmd, queue, timeout?, group? }`        | `{ ok, job, token? }`                           |
| `PULLB` | Get batch      | `{ cmd, queue, count, timeout?, group? }` | `{ ok, jobs, tokens? }`                         |
| `ACK`   | Complete job   | `{ cmd, id, result?, token? }`            | `{ ok, data?: { applied, reason } }`            |
| `ACKB`  | Complete batch | `{ cmd, ids, results?, tokens? }`         | `{ ok, data?: { ignoredIds, ignoredIndices } }` |
| `FAIL`  | Fail job       | `{ cmd, id, error?, token? }`             | `{ ok, data?: { applied, reason } }`            |

### Query Commands

| Command                | Description                |
| ---------------------- | -------------------------- |
| `GetJob`               | Get job by ID              |
| `GetJobByCustomId`     | Get job by custom ID       |
| `GetState`             | Get job state              |
| `GetResult`            | Get job result             |
| `GetJobs`              | List jobs with filters     |
| `GetJobCounts`         | Queue statistics           |
| `GetCountsPerPriority` | Counts grouped by priority |
| `GetProgress`          | Get job progress           |
| `Count`                | Count jobs in queue        |

### Job Group Commands

`GetGroupJobsCount`, `GetGroupsJobsCount`, and `GetGroupActiveCount` expose
server-authoritative depth. `Set/Get/RemoveGroupRateLimit`,
`GetGroupRateLimitTtl`, and `Set/Get/RemoveGroupConcurrency` manage local group
overrides. Results are wrapped in `data`; see the [wire reference](/api/tcp/control/#job-group-controls-and-getters)
for exact shapes.

### Control Commands

| Command         | Description                 |
| --------------- | --------------------------- |
| `Pause`         | Stop processing queue       |
| `Resume`        | Resume processing           |
| `IsPaused`      | Check if queue is paused    |
| `Drain`         | Remove waiting jobs         |
| `Obliterate`    | Delete queue completely     |
| `Clean`         | Remove old jobs             |
| `Cancel`        | Cancel pending job          |
| `Promote`       | Move delayed job to waiting |
| `MoveToDelayed` | Move job to delayed state   |
| `Progress`      | Update job progress         |
| `ListQueues`    | List all queues             |

### DLQ Commands

| Command          | Description          |
| ---------------- | -------------------- |
| `Dlq`            | List DLQ entries     |
| `RetryDlq`       | Retry failed jobs    |
| `RetryCompleted` | Retry completed jobs |
| `PurgeDlq`       | Clear DLQ            |

### Cron Commands

| Command      | Description           |
| ------------ | --------------------- |
| `Cron`       | Add scheduled job     |
| `CronGet`    | Get one scheduled job |
| `CronDelete` | Remove scheduled job  |
| `CronList`   | List all cron jobs    |

### Monitoring Commands

| Command            | Description                 |
| ------------------ | --------------------------- |
| `Stats`            | Server statistics           |
| `Metrics`          | Queue metrics               |
| `Prometheus`       | Prometheus format           |
| `Ping`             | Health check                |
| `Heartbeat`        | Worker heartbeat            |
| `JobHeartbeat`     | Per-job heartbeat           |
| `AddLog`           | Add job log entry           |
| `GetLogs`          | Get job logs                |
| `RegisterWorker`   | Register worker with server |
| `UnregisterWorker` | Unregister worker           |
| `ListWorkers`      | List registered workers     |

## Connection Pool

The client maintains a pool of TCP connections for load balancing:

```typescript
// Default: 4 connections, configurable via poolSize
const pool = new TcpConnectionPool({
  host: 'localhost',
  port: 6789,
  poolSize: 32, // 32 connections for high throughput
});
```

**Selection strategy:** Round-robin, preferring connected sockets.

`TcpConnectionPool` and `getSharedPool` also take the connection-level reconnect and
health settings, validated like the options above:

| Option                 | Default    | Description                                                                 |
| ---------------------- | ---------- | --------------------------------------------------------------------------- |
| `connectTimeout`       | `5000`     | Connection attempt timeout (ms, finite, `>= 1`)                             |
| `autoReconnect`        | `true`     | Reconnect after a lost connection                                           |
| `reconnectDelay`       | `100`      | First reconnect delay, doubled per attempt (ms, finite, `>= 1`)             |
| `maxReconnectDelay`    | `30000`    | Reconnect delay ceiling, plus up to 30% jitter (ms, finite, `>= 1`)         |
| `maxReconnectAttempts` | `Infinity` | Attempts before giving up (a whole number; `0` gives up at once)            |
| `maxPingFailures`      | `3`        | Consecutive failed pings before a reconnect (a whole number `>= 1`, or `Infinity`) |

`getSharedPool` checks the options before it looks up an existing pool, so invalid
options never receive a shared one, and it shares a pool only between callers whose
options are all equal (unset, `undefined` and the explicit default count as equal): a
`Queue` with other timeouts, ping or reconnect settings, or another token, gets its own
pool instead of silently running with the first caller's.

**Features:**

- Automatic reconnection
- Health tracking (latency, errors)
- Shared pools (reference counted)

## Client Disconnect Handling

When a client disconnects, the server:

1. Identifies all jobs owned by client
2. Releases job locks (returns to queue)
3. Cleans up client tracking

Jobs with active locks are automatically requeued for other workers.

## Validation Limits

| Parameter                                  | Limit                                                     |
| ------------------------------------------ | --------------------------------------------------------- |
| Queue name                                 | Max 256 chars, alphanumeric + `_-.:`                      |
| Job data                                   | Max 10 MB JSON on push (an `Update` has no size limit)    |
| Priority                                   | Any finite number (grouped: integer 0 to 2,097,151)       |
| Delay                                      | Finite; a negative delay is a past run time (ready, sorts first) |
| Timeout, TTL                               | Finite, 0 or more                                         |
| Stall timeout (`stallTimeout`)             | Finite                                                    |
| Max attempts                               | Any number (`Infinity` allowed); 1 or less runs once, a fraction rounds up, at most 2,147,483,647 |
| Backoff (number, `delay`)                  | Finite, 0 or more; the object form's `delay` defaults to 1000 |
| Backoff `maxDelay`                         | 0 to 24 hours                                             |
| `timestamp`                                | Within ±4,320,000,000,000,000                             |
| `dedup.ttl`, `debounceTtl`, `repeat.every` | Finite (`repeat.every` must be positive)                  |
| `stackTraceLimit` / `keepLogs` / `sizeLimit` | Finite (stored as given)                                |
| ChangeDelay/MoveToDelayed `delay`          | Required, finite; a negative delay is a past run time (ready, sorts first) |
| `lockTtl`, ExtendLock(s)/JobHeartbeat `duration` | Any finite number (as in 2.9.10)                    |
| ChangePriority `priority`                  | Any finite number; missing means 0; `lifo` is made a boolean |

Every value must be a finite number (a plain numeric string counts as its number);
durations above about 136,900 years are clamped. Every value 2.9.10 accepted in either
mode is still accepted with the same result. Embedded mode applies the same rules
(`Queue.add`, `addBulk`, flows, job schedulers and job commands throw the same
messages, naming the SDK option such as `attempts`), so a job is never admitted in one
mode and refused in the other.

## HTTP Endpoints

bunqueue also exposes an HTTP API on port 6790:

| Endpoint              | Method | Description           |
| --------------------- | ------ | --------------------- |
| `/health`             | GET    | Health + memory stats |
| `/healthz`            | GET    | Kubernetes liveness   |
| `/ready`              | GET    | Kubernetes readiness  |
| `/prometheus`         | GET    | Prometheus metrics    |
| `/stats`              | GET    | JSON statistics       |
| `/queues/:queue/jobs` | POST   | Add job               |
| `/queues/:queue/jobs` | GET    | Pull job              |
| `/jobs/:id`           | GET    | Get job               |
| `/jobs/:id/ack`       | POST   | Acknowledge           |
| `/jobs/:id/fail`      | POST   | Fail                  |
| `/ws`                 | GET    | WebSocket             |
| `/events`             | GET    | Server-Sent Events    |

:::tip[Related]

- [Architecture Overview](/architecture/) - Full component map
- [TCP Protocol Reference](/api/tcp/) - Command-by-command wire spec
- [Persistence](/architecture/persistence/) - MessagePack serialization shared with storage
- [Client SDK Architecture](/architecture/client-sdk/) - The pool that speaks this protocol
  :::
