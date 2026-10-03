---
title: 'TCP Worker and Webhook Commands'
description: 'bunqueue TCP worker and webhook commands: register, unregister and list workers, and add, remove and list webhooks with SSRF-checked URLs.'
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/api/tcp/workers.png
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">api reference · tcp · workers</span>
  <h1 class="bq-hero-h1 bq-bench-h1">Workers and webhooks, <em>registered.</em></h1>
  <p class="bq-hero-sub">Register, unregister and list workers for monitoring, and manage the webhooks that receive job event notifications.</p>
</div>

Part of the [TCP protocol reference](/api/tcp/), which describes the framing, authentication, pipelining and response format that every command on this page uses.

Worker heartbeats ([`Heartbeat`](/api/tcp/monitoring/#heartbeat)) are documented with the monitoring commands, and [`SetWebhookEnabled`](/api/tcp/jobs/#setwebhookenabled) with the job commands.

## Worker Commands

### RegisterWorker

Register a worker with the server for monitoring.

**Request:**

```typescript
{
  cmd: 'RegisterWorker',
  name: string,
  queues: string[],      // Queues this worker processes
  concurrency?: number,
  workerId?: string,     // Reuse a stable worker ID across reconnects
  hostname?: string,
  pid?: number,
  startedAt?: number
}
```

**Response:**

```typescript
{
  ok: true,
  data: {
    workerId: string,
    name: string,
    queues: string[],
    concurrency: number,
    hostname: string,    // 'unknown' when not supplied
    pid: number,         // 0 when not supplied
    status: 'active',
    registeredAt: number,
    lastSeen: number,
    activeJobs: number,
    processedJobs: number,
    failedJobs: number,
    currentJob: string | null
  }
}
```

The registration is tied to the TCP connection: the server auto-unregisters the worker when the connection closes.

---

### UnregisterWorker

Remove a worker registration.

**Request:**

```typescript
{ cmd: 'UnregisterWorker', workerId: string }
```

**Response:**

```typescript
{ ok: true, data: { removed: true } }
```

---

### ListWorkers

List all registered workers and their stats.

**Request:**

```typescript
{
  cmd: 'ListWorkers';
}
```

**Response:**

```typescript
{
  ok: true,
  data: {
    workers: Array<{
      id: string,
      name: string,
      queues: string[],
      concurrency: number,
      hostname: string,
      pid: number,
      status: 'active' | 'stale',   // stale = no heartbeat within WORKER_TIMEOUT_MS (default 30s)
      registeredAt: number,
      lastSeen: number,
      activeJobs: number,
      processedJobs: number,
      failedJobs: number,
      currentJob: string | null,
      uptime: number
    }>,
    stats: object          // Aggregated worker stats
  }
}
```

---

## Webhook Commands

### AddWebhook

Register a webhook to receive event notifications. URLs are validated to prevent SSRF (localhost, private IPs, and cloud metadata endpoints are blocked).

**Request:**

```typescript
{
  cmd: 'AddWebhook',
  url: string,           // Webhook URL (https required for production)
  events: string[],      // 'job.pushed' | 'job.started' | 'job.completed' | 'job.failed' | 'job.progress'
  queue?: string,        // Filter by queue (optional)
  secret?: string        // Signing secret for payload verification
}
```

**Response:**

```typescript
{
  ok: true,
  data: {
    webhookId: string,
    url: string,
    events: string[],
    queue: string | null,
    createdAt: number
  }
}
```

---

### RemoveWebhook

Remove a registered webhook.

**Request:**

```typescript
{ cmd: 'RemoveWebhook', webhookId: string }
```

**Response:**

```typescript
{ ok: true, data: { removed: true } }
```

---

### ListWebhooks

List all registered webhooks.

**Request:**

```typescript
{
  cmd: 'ListWebhooks';
}
```

**Response:**

```typescript
{
  ok: true,
  data: {
    webhooks: Array<{
      id: string,
      url: string,
      events: string[],
      queue: string | null,
      createdAt: number,
      lastTriggered: number | null,
      successCount: number,
      failureCount: number,
      enabled: boolean
    }>,
    stats: object
  }
}
```
