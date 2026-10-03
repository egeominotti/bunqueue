---
title: 'TCP Monitoring Commands: Stats, Metrics, Health'
description: 'bunqueue TCP monitoring commands: ping, hello, stats, metrics, Prometheus text, storage health, worker and job heartbeats, and dashboard snapshots.'
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/api/tcp/monitoring.png
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">api reference · tcp · monitoring</span>
  <h1 class="bq-hero-h1 bq-bench-h1">Health, metrics <em>and heartbeats.</em></h1>
  <p class="bq-hero-sub">Health checks, protocol negotiation, server statistics and metrics, Prometheus output, storage health, worker and job heartbeats, and the aggregated dashboard snapshots.</p>
</div>

Part of the [TCP protocol reference](/api/tcp/), which describes the framing, authentication, pipelining and response format that every command on this page uses.

## Monitoring Commands

### Ping

Connection health check.

**Request:**

```typescript
{
  cmd: 'Ping';
}
```

**Response:**

```typescript
{ ok: true, data: { pong: true, time: number } }
```

---

### Hello

Protocol version negotiation and server capability discovery. See the [Protocol Negotiation](/api/tcp/#protocol-negotiation-hello) section of the overview for details.

**Request:**

```typescript
{
  cmd: 'Hello',
  protocolVersion: number,
  capabilities?: Array<'pipelining' | 'separate-job-name'>
}
```

**Response:**

```typescript
{
  ok: true,
  protocolVersion: number,
  capabilities: Array<'pipelining' | 'separate-job-name'>,
  server: 'bunqueue',
  version: string
}
```

---

### Stats

Get high-level server statistics.

**Request:**

```typescript
{
  cmd: 'Stats';
}
```

**Response:**

```typescript
{
  ok: true,
  stats: {
    waiting: number,      // Waiting jobs
    active: number,       // Active jobs
    delayed: number,      // Delayed jobs
    dlq: number,          // Dead-letter queue size
    completed: number,    // Completed count
    failed: number,       // Failed (totalFailed) count
    uptime: number,       // Server uptime in ms
    pushPerSec: number,   // Push throughput
    pullPerSec: number    // Pull throughput
  }
}
```

---

### Metrics

Get detailed server metrics. The request without queue fields retains the
legacy broker-wide response shown below.

**Request:**

```typescript
{
  cmd: 'Metrics';
}
```

**Response:**

```typescript
{
  ok: true,
  metrics: {
    totalPushed: number,
    totalPulled: number,
    totalCompleted: number,
    totalFailed: number,
    avgLatencyMs: number,
    avgProcessingMs: number,
    memoryUsageMb: number,
    sqliteSizeMb: number,
    activeConnections: number
  }
}
```

For durable queue-scoped minute metrics, send:

```typescript
{
  cmd: 'Metrics',
  queue: 'emails',
  type: 'completed', // or 'failed'
  start: 0,          // newest bucket index
  end: -1            // through the oldest retained bucket
}
```

```typescript
{
  ok: true,
  data: {
    meta: { count: number, prevTS: number, prevCount: number },
    data: number[], // one-minute buckets, newest first
    count: number   // bucket count before pagination
  }
}
```

### TrimEvents

Keep only the newest lifecycle events for one queue. The response reports the
exact removed count, so repeating the request at the same length returns zero.

```typescript
{ cmd: 'TrimEvents', queue: 'emails', maxLength: 1000 }
```

```typescript
{ ok: true, data: { removed: number } }
```

---

### Prometheus

Get metrics in Prometheus text exposition format.

**Request:**

```typescript
{
  cmd: 'Prometheus';
}
```

**Response:**

```typescript
{ ok: true, data: { metrics: string } }
```

---

### StorageStatus

Get the storage/disk health status. Reports whether the disk is full or has errors.

**Request:**

```typescript
{
  cmd: 'StorageStatus';
}
```

**Response:**

```typescript
{
  ok: true,
  data: {
    diskFull: boolean,         // Whether the disk is full
    error: string | null,      // Error message if any
    since: number | null       // Timestamp when the issue started (ms since epoch)
  }
}
```

---

### Heartbeat

Send a heartbeat for a registered worker (keeps the worker registration alive).

**Request:**

```typescript
{
  cmd: 'Heartbeat',
  id: string,            // Worker ID
  activeJobs?: number,   // Optional stats update
  processed?: number,
  failed?: number
}
```

**Response:**

```typescript
{ ok: true, data: { ok: true } }
```

---

### JobHeartbeat

Send a heartbeat for an active job (prevents stall detection from marking it as stalled). Also renews the lock if a token is provided.

**Request:**

```typescript
{
  cmd: 'JobHeartbeat',
  id: string,           // Job ID
  token?: string,       // Lock token for renewal
  duration?: number     // Lock renewal duration in ms (with token: extends the lock)
}
```

**Response:**

```typescript
{ ok: true, data: { ok: true } }
```

---

### JobHeartbeatB

Batch job heartbeat for multiple active jobs.

**Request:**

```typescript
{
  cmd: 'JobHeartbeatB',
  ids: string[],         // Job IDs
  tokens?: string[]      // Lock tokens (same order as ids)
}
```

**Response:**

```typescript
{ ok: true, data: { ok: true, count: number } }
```

---

## Dashboard Commands

Aggregated read-only snapshots for dashboards (same data as the HTTP `/dashboard` endpoints).

### DashboardOverview

**Request:** `{ cmd: 'DashboardOverview' }`

**Response:** `{ ok: true, data: { stats, throughput, latency, memory, collections, workers, crons, storage, timestamp } }`

### DashboardQueues

**Request:** `{ cmd: 'DashboardQueues' }`

**Response:** `{ ok: true, data: { queues: Array<{ name, waiting, prioritized, delayed, active, dlq, paused }>, timestamp } }`

### DashboardQueue

**Request:** `{ cmd: 'DashboardQueue', queue: string, includeJobs?: boolean, jobsLimit?: number }` (`jobsLimit` default 10, max 50)

**Response:** `{ ok: true, data: { name, counts, paused, priorityCounts, dlqPreview, jobs?, timestamp } }`
