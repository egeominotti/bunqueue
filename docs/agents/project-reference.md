# Project Reference (agents)

Reference material moved verbatim from the root `CLAUDE.md` when it became a short
routing page (the repository map at the end comes from `AGENTS.md`); this
introduction is new. The mandatory rules (gates, tooling, the 300-line ceiling, the lock
hierarchy) stay in [`CLAUDE.md`](../../CLAUDE.md) and [`AGENTS.md`](../../AGENTS.md);
this page is the on-demand detail. The authoritative engineering reference is
[`docs/README.md`](../README.md), [`architecture.md`](../architecture.md) and
[`data-model.md`](../data-model.md): when this summary and those documents disagree,
those documents and the code win, and this page is corrected in the same change-set.

Client APIs (Simple Mode, Workflow Engine, Client SDK, job and worker options) are in
[client-reference.md](./client-reference.md); debug endpoints and profiling in
[debugging.md](./debugging.md); publishing and release posts in [release.md](./release.md).

High-performance job queue server for Bun. SQLite persistence, cron jobs, priorities, DLQ, S3 backups.

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT                                          │
│  Queue.add() ─────┐                              ┌───── Worker.process()    │
│  Queue.addBulk() ─┤                              │                          │
│                   ▼                              ▼                          │
│            ┌──────────┐                   ┌──────────┐                      │
│            │ TcpPool  │◄─── msgpack ────► │ TcpPool  │                      │
│            └────┬─────┘                   └────┬─────┘                      │
└─────────────────┼──────────────────────────────┼────────────────────────────┘
                  │ TCP :6789                    │
┌─────────────────┼──────────────────────────────┼────────────────────────────┐
│                 ▼           SERVER             ▼                            │
│          ┌───────────┐                  ┌───────────┐                       │
│          │ TcpServer │                  │ TcpServer │                       │
│          └─────┬─────┘                  └─────┬─────┘                       │
│                │                              │                             │
│                ▼                              ▼                             │
│   ┌────────────────────────────────────────────────────────────┐           │
│   │                    QueueManager                             │           │
│   │  ┌─────────────────────────────────────────────────────┐   │           │
│   │  │              N Shards (auto-detected)                │   │           │
│   │  │  ┌─────────┬─────────┬─────────┬─────────┐          │   │           │
│   │  │  │ Shard 0 │ Shard 1 │   ...   │ Shard N │          │   │           │
│   │  │  │┌───────┐│┌───────┐│         │┌───────┐│          │   │           │
│   │  │  ││PQueue ││PQueue ││         ││PQueue ││          │   │           │
│   │  │  │└───────┘│└───────┘│         │└───────┘│          │   │           │
│   │  │  └─────────┴─────────┴─────────┴─────────┘          │   │           │
│   │  └─────────────────────────────────────────────────────┘   │           │
│   │                           │                                 │           │
│   │  ┌────────────────────────┼────────────────────────────┐   │           │
│   │  │  jobIndex (Map)        │   completedJobs (Set)      │   │           │
│   │  │  customIdMap (LRU)     │   jobResults (LRU)         │   │           │
│   │  └────────────────────────┼────────────────────────────┘   │           │
│   └───────────────────────────┼─────────────────────────────────┘           │
│                               │                                             │
│   ┌───────────────────────────┼─────────────────────────────────┐           │
│   │                           ▼                                 │           │
│   │  ┌─────────────┐    ┌──────────┐    ┌─────────────┐        │           │
│   │  │ WriteBuffer │───►│ SQLite   │◄───│ Recovery /  │        │           │
│   │  │ (10ms batch)│    │ WAL Mode │    │ SQL queries │        │           │
│   │  └─────────────┘    └──────────┘    └─────────────┘        │           │
│   │                      Persistence                            │           │
│   └─────────────────────────────────────────────────────────────┘           │
│                                                                             │
│   ┌───────────────────────────────────────────────────────────┐             │
│   │  Background Tasks                                          │             │
│   │  • Scheduler (cron, delayed jobs)    • Stall detector     │             │
│   │  • DLQ maintenance (retry, expire)   • Lock expiration    │             │
│   │  • Cleanup (memory bounds)           • S3 backup          │             │
│   └───────────────────────────────────────────────────────────┘             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Request Flow:**

1. **PUSH**: Client → TcpPool → TcpServer → QueueManager → Shard[hash(queue)] → PriorityQueue → WriteBuffer → SQLite
2. **PULL**: Client → TcpServer → QueueManager → Shard → PriorityQueue.pop() → Job (state: active)
3. **ACK**: Worker → optional client-side AckBatcher → TCP handler (`handlers/core.ts`) → QueueManager.ack → `operations/ack/completion.ts` → shard/index/storage, jobResults (LRU) + completedJobs (Set)
4. **FAIL**: Client → TCP handler (`handlers/core.ts`) → QueueManager.fail → `operations/ack/failure.ts` → shard/index/storage → retry (backoff) OR → DLQ (max attempts)

## Directory Structure

```
src/
├── cli/              # CLI interface (commands/, client.ts, output.ts)
├── client/           # Embedded SDK (Queue, Worker, FlowProducer, QueueGroup)
│   ├── queue/        # Queue with DLQ, stall detection
│   ├── worker/       # Worker with heartbeat, ack batching
│   └── tcp/          # Connection pool, reconnection
├── domain/           # Pure business logic (types/, queue/)
│   └── queue/        # Shard, PriorityQueue, DlqShard, UniqueKeyManager
├── application/      # Use cases (operations/, managers)
│   ├── operations/   # push, pull, ack, query, queueControl
│   └── *Manager.ts   # DLQ, Events, Workers, JobLogs, Stats
├── infrastructure/   # External (persistence/, server/, scheduler/, backup/)
└── shared/           # Utilities (hash, lock, lru, skipList, minHeap)
```

## Code Guidelines

- **MAX 300 lines per file** - split if larger
- One concern per file (Single Responsibility)
- Export only what's needed

## Sharding (auto-detected from CPU cores)

Shard count is automatically calculated based on CPU cores (power of 2, max 64):

```typescript
// Calculated at startup based on navigator.hardwareConcurrency
// Examples: 4 cores → 4 shards, 10 cores → 16 shards, 20 cores → 32 shards
const SHARD_COUNT = calculateShardCount(); // Power of 2, capped at 64
const SHARD_MASK = SHARD_COUNT - 1;
const shardIndex = (key: string) => fnv1aHash(key) & SHARD_MASK;
```

## Lock Hierarchy (acquire in order)

1. `jobIndex` → 2. `completedJobs` → 3. `shards[N]` → 4. `processingShards[N]`

```typescript
// CORRECT: read first, then acquire lock
const completed = completedJobs.has(id);
const shard = await shards[idx].acquire();
try {
  /* work */
} finally {
  shard.release();
}
```

## Memory Bounds

| Collection     | Max Size          | Eviction                                     |
| -------------- | ----------------- | -------------------------------------------- |
| completedJobs  | 50,000            | FIFO batch                                   |
| jobResults     | 10,000            | LRU                                          |
| jobLogs        | 10,000            | LRU                                          |
| customIdMap    | 50,000            | LRU                                          |
| removedResults | 1,000 (60 s TTL)  | Expired first; 10% batch at cap; memory only |

Cleanup runs every 10s (it also purges expired `removedResults`). Evicts 10% when full.

## Environment Variables

```bash
# Server
TCP_PORT=6789              HTTP_PORT=6790
HOST=0.0.0.0               BUNQUEUE_DATA_PATH=./data/bunq.db
AUTH_TOKENS=token1,token2  CORS_ALLOW_ORIGIN=*
METRICS_AUTH=false          # Require auth for /prometheus scrape endpoint
TCP_SOCKET_PATH=           # RESERVED, not wired: TCP always binds HOST:TCP_PORT
                           # (client ConnectionOptions.socketPath is not read either)
HTTP_SOCKET_PATH=          # Unix socket for HTTP (works)
TLS_CERT_FILE=             # PEM cert — native TLS on TCP+HTTP (with TLS_KEY_FILE); SIGHUP reloads
TLS_KEY_FILE=              # PEM private key (both or neither; partial = startup error)

# Memory-only result of removeOnComplete jobs for late waits (memory/SQLite; 0 = off)
BUNQUEUE_REMOVED_RESULT_RETENTION_MS=60000  BUNQUEUE_MAX_REMOVED_RESULTS=1000

# Data path (priority: BUNQUEUE_DATA_PATH > BQ_DATA_PATH > DATA_PATH > SQLITE_PATH)
# Or set programmatically: new Queue('q', { embedded: true, dataPath: './data/q.db' })

# S3 Backup
S3_BACKUP_ENABLED=0        S3_BUCKET=my-bucket
S3_ACCESS_KEY_ID=          S3_SECRET_ACCESS_KEY=
S3_REGION=us-east-1        S3_ENDPOINT=
S3_BACKUP_INTERVAL=21600000  S3_BACKUP_RETENTION=7

# Timeouts
SHUTDOWN_TIMEOUT_MS=30000  STATS_INTERVAL_MS=300000
WORKER_TIMEOUT_MS=30000    LOCK_TIMEOUT_MS=5000
WEBHOOK_MAX_RETRIES=3      WEBHOOK_RETRY_DELAY_MS=1000

# Cloud (bunqueue.io dashboard)
BUNQUEUE_CLOUD_URL=        BUNQUEUE_CLOUD_API_KEY=
BUNQUEUE_CLOUD_INSTANCE_ID=    # REQUIRED for cloud mode
BUNQUEUE_CLOUD_INSTANCE_NAME=  # defaults to hostname
BUNQUEUE_CLOUD_INTERVAL_MS=15000  # validated only; cadence is adaptive (5-30s by snapshot size)
BUNQUEUE_CLOUD_USE_WEBSOCKET=true
BUNQUEUE_CLOUD_USE_HTTP=true
BUNQUEUE_CLOUD_REMOTE_COMMANDS=true   # opt out with false/0/no/off
BUNQUEUE_CLOUD_INCLUDE_JOB_DATA=true  # opt out with false/0/no/off
BUNQUEUE_CLOUD_REDACT_FIELDS=  # comma-separated
BUNQUEUE_CLOUD_EVENTS=         # event filter, comma-separated
BUNQUEUE_CLOUD_BUFFER_SIZE=720
BUNQUEUE_CLOUD_CIRCUIT_BREAKER_THRESHOLD=5
BUNQUEUE_CLOUD_CIRCUIT_BREAKER_RESET_MS=60000
BUNQUEUE_CLOUD_SIGNING_SECRET=  # HMAC signing
```

## TCP Protocol Commands

**Core:** `PUSH`, `PUSHB`, `PULL`, `PULLB`, `ACK`, `ACKB`, `FAIL`

**Query:** `GetJob`, `GetState`, `GetResult`, `GetJobs`, `GetJobCounts`, `GetProgress`, `Count`

**Control:** `Pause`, `Resume`, `Drain`, `Obliterate`, `Clean`, `Cancel`, `Promote`, `Update`, `ChangePriority`

**DLQ:** `Dlq`, `RetryDlq`, `PurgeDlq`

**Cron:** `Cron`, `CronDelete`, `CronList`

**Monitor:** `Stats`, `Metrics`, `Prometheus`, `Ping`, `Heartbeat`, `JobHeartbeat`

**Workers:** `RegisterWorker`, `UnregisterWorker`, `ListWorkers`

**Webhooks:** `AddWebhook`, `RemoveWebhook`, `ListWebhooks`

**Rate:** `RateLimit`, `RateLimitClear`, `SetConcurrency`, `ClearConcurrency`

## CLI Usage

```bash
# Server
bunqueue start --tcp-port 6789 --data-path ./data/queue.db

# Client
bunqueue push <queue> <json> [--priority N] [--delay ms]
bunqueue pull <queue> [--timeout ms]
bunqueue ack <id> [--result json]
bunqueue fail <id> [--error msg]
bunqueue job get|state|cancel|promote|discard <id>
bunqueue queue pause|resume|drain|obliterate <queue>
bunqueue dlq list|retry|purge <queue>
bunqueue cron list|add|delete
bunqueue stats|metrics|health
```


## SQLite Schema (Key Tables)

```sql
-- Jobs: id, queue, data, priority, state, run_at, attempts, ...
CREATE INDEX idx_jobs_queue_state ON jobs(queue, state);
CREATE INDEX idx_jobs_run_at ON jobs(run_at)
  WHERE state IN ('waiting','prioritized','waiting-children','delayed');

-- DLQ: id, job_id, queue, entry (msgpack blob), entered_at
-- Cron: name, queue, data, schedule, repeat_every, next_run, timezone
-- Results: job_id, result, completed_at
```

## Testing

```bash
bun test --parallel=4                   # Run in each required OrbStack Machine
bun scripts/tcp/run-all-tests.ts        # Run in each required OrbStack Machine
bun scripts/embedded/run-all-tests.ts   # Run in each required OrbStack Machine
bun run test:sandbox                    # Additional container-isolated full gate
bun run test:sandbox:sdk                # Additional gate after SDK changes
bun run bench                           # Native macOS benchmarks only
```


## Performance

| Mode               | Throughput      | Data Loss Risk |
| ------------------ | --------------- | -------------- |
| Buffered (default) | ~100k jobs/sec  | Pending application buffer; typical flush interval 10 ms, longer during stalls/retries |
| Durable            | ~10k jobs/sec   | Bypasses the application admission buffer; host/storage power-loss limitations remain |
| Auto-batch (TCP)   | ~145k ops/s (concurrent), ~10k ops/s (sequential) | Inherits the selected PUSH/PUSHB admission durability |

These throughput figures are indicative historical measurements, not results of
this documentation review. SQLite uses WAL with `synchronous=NORMAL`; durable
admission does not promise unconditional power-loss safety. See
[Persistence](../features/persistence.md).


## Background Tasks

| Task            | Interval | Purpose                        |
| --------------- | -------- | ------------------------------ |
| Cleanup         | 10s      | Memory cleanup, orphan removal |
| Stall check     | 5s       | Detect unresponsive jobs       |
| Dependency      | event-driven (30s safety fallback) | Process job dependencies |
| DLQ maintenance | 60s      | Auto-retry, expiration         |
| Lock expiration | 5s       | Remove expired locks           |

## Repository map

Moved verbatim from the root `AGENTS.md`.

- `src/application/`: queue orchestration and use-case logic.
- `src/domain/`: jobs, shards, priority queues, counters, and limiters.
- `src/infrastructure/`: SQLite persistence and transport adapters.
- `src/client/`: public Queue/Worker APIs.
- `test/`: Bun unit, integration, regression, and reproduction tests.
- `docs/`: documentation site.
- `sdk/`: language SDKs and conformance fixtures.
