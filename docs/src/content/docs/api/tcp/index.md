---
title: 'TCP Protocol Reference: Binary MessagePack Commands'
description: 'TCP protocol spec for bunqueue: MessagePack wire format, length-prefixed framing, pipelining, auth, and a linked summary of every command by family.'
head:
  - tag: meta
    attrs:
      property: og:image
      content: https://bunqueue.dev/og/api/tcp.png
---

<div class="bq-wrap bq-hero">
  <span class="bq-eyebrow">api reference · tcp</span>
  <h1 class="bq-hero-h1 bq-bench-h1">The wire protocol, <em>documented.</em></h1>
  <p class="bq-hero-sub">A high-performance binary protocol on port <code>6789</code> by default. All messages use MessagePack encoding with length-prefixed framing, and pipelining lets the server process commands concurrently.</p>
</div>

## Wire Format

Every message (request and response) is wrapped in a length-prefixed frame:

<div class="bq-diag">
  <div class="bq-diag-head"><b>Frame layout</b><span>request and response</span></div>
  <div class="bq-diag-flow">
    <div class="bq-diag-cell">payload length <i>4 bytes, big-endian unsigned 32-bit</i></div>
    <div class="bq-diag-cell bq-diag-accent">MessagePack payload <i>N bytes</i></div>
  </div>
</div>

The framing protocol works as follows:

1. The first 4 bytes are a big-endian unsigned 32-bit integer indicating the length of the MessagePack payload.
2. The next N bytes are the MessagePack-encoded command or response object.
3. Maximum frame size is **64 MB**. Frames exceeding this limit cause the connection to be terminated.

### Encoding Example

```typescript
import { pack, unpack } from 'msgpackr';

// Encode a command into a framed message
function frameCommand(cmd: object): Uint8Array {
  const payload = pack(cmd);
  const frame = new Uint8Array(4 + payload.length);
  // Write length prefix (big-endian u32)
  frame[0] = (payload.length >> 24) & 0xff;
  frame[1] = (payload.length >> 16) & 0xff;
  frame[2] = (payload.length >> 8) & 0xff;
  frame[3] = payload.length & 0xff;
  frame.set(payload, 4);
  return frame;
}

// Decode a framed response (skip the 4-byte length prefix)
function decodeFrame(frame: Uint8Array): object {
  return unpack(frame.subarray(4));
}
```

## Connection

```typescript
import { pack, unpack } from 'msgpackr';

const socket = await Bun.connect({
  hostname: 'localhost',
  port: 6789,
  socket: {
    data(socket, data) {
      // Parse frames from data, then unpack each frame with msgpackr
    },
  },
});

// Send a command
const cmd = pack({ cmd: 'Ping' });
const frame = new Uint8Array(4 + cmd.length);
frame[0] = (cmd.length >> 24) & 0xff;
frame[1] = (cmd.length >> 16) & 0xff;
frame[2] = (cmd.length >> 8) & 0xff;
frame[3] = cmd.length & 0xff;
frame.set(cmd, 4);
socket.write(frame);
```

## Protocol Negotiation (Hello)

Clients should send a `Hello` command after connecting to report their protocol revision and discover server capabilities.

**Request:**

```typescript
{ cmd: 'Hello', protocolVersion: 3, capabilities: ['pipelining', 'separate-job-name'] }
```

**Response:**

```typescript
{
  ok: true,
  protocolVersion: 3,
  capabilities: ['pipelining', 'separate-job-name'],
  server: 'bunqueue',
  version: 'x.y.z'  // Installed server package version
}
```

The current protocol version is **3**. It supports `pipelining` and
`separate-job-name`. Revision 3 places job metadata in top-level `job.name`
and preserves `job.data` exactly as supplied. The server still accepts legacy
inputs with no top-level `name`: at that inbound boundary only, a string
`data.name` is decoded as the old embedded-name envelope.

## Pipelining

The server supports **pipelining**: clients can send multiple commands without waiting for each response. The server processes frames in parallel with a concurrency limit of **50 commands per connection**, controlled by a semaphore.

To correlate responses with requests when pipelining, include a `reqId` field in each command. The server echoes `reqId` back in the corresponding response.

```typescript
// Send two commands simultaneously
socket.write(frameCommand({ cmd: 'PUSH', queue: 'emails', data: { to: 'a@b.com' }, reqId: '1' }));
socket.write(frameCommand({ cmd: 'PUSH', queue: 'emails', data: { to: 'c@d.com' }, reqId: '2' }));

// Responses may arrive in any order - match by reqId
// { ok: true, id: 'abc-123', reqId: '1' }
// { ok: true, id: 'def-456', reqId: '2' }
```

## Authentication

When the server is configured with `AUTH_TOKENS`, all connections must authenticate before sending other commands. The `Auth` command is always permitted regardless of authentication state.

**Request:**

```typescript
{ cmd: 'Auth', token: 'your-secret-token' }
```

**Response (success):**

```typescript
{
  ok: true;
}
```

**Response (failure):**

```typescript
{ ok: false, error: 'Invalid token' }
```

If auth tokens are configured and a client sends any command before authenticating, the server responds with:

```typescript
{ ok: false, error: 'Not authenticated' }
```

## Response Format

All responses include an `ok` boolean field. On success `ok` is `true` with command-specific data. On failure `ok` is `false` with an `error` string.

```typescript
// Success
{ ok: true, ...data, reqId?: string }

// Error
{ ok: false, error: 'Error message', reqId?: string }
```

### Queue event frames

`SubscribeEvents` selects one queue for the current connection;
`UnsubscribeEvents` clears it without closing the socket. Both commands require
normal authentication and return a regular `reqId`-correlated response.

```typescript
{ cmd: 'SubscribeEvents', queue: 'tasks', reqId: 'events-1' }
{ ok: true, reqId: 'events-1' }

// Later, independently of command responses:
{ type: 'event', event: { eventType: 'completed', queue: 'tasks', jobId: '...', timestamp: 0, data: { ok: true } } }

{ cmd: 'UnsubscribeEvents', reqId: 'events-2' }
```

The unsolicited event envelope has no `reqId`. Pipelined clients must recognize
`type: 'event'` before correlating command responses. A new subscription on the
same connection replaces the previous queue. Slow subscribers are subject to
the normal per-connection write-buffer limit.

## Connection Lifecycle

When a TCP connection closes, the server automatically releases all jobs that were being processed by that client back to their queues. This uses retry logic with exponential backoff (up to 3 attempts) to ensure jobs are not left in an inconsistent state.

## Rate Limiting

Each connection is subject to server-side rate limiting. If exceeded, the server responds with:

```typescript
{ ok: false, error: 'Rate limit exceeded' }
```

---

## Command Reference

Every command object must include a `cmd` field. An optional `reqId` field can be included for request-response correlation (required for pipelining).

The commands are documented by family on the pages below, and the [command summary](#command-summary) links every command to its section.

| Page                                    | Command families                                                                                                                                                  | Covers                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [Jobs](/api/tcp/jobs/)                  | [Core](/api/tcp/jobs/#core-commands), [Log](/api/tcp/jobs/#log-commands), [Lock](/api/tcp/jobs/#lock-commands), [More Job](/api/tcp/jobs/#more-job-commands)      | Add, claim, acknowledge and fail jobs; job logs; lock extension; more job transitions                    |
| [Queries](/api/tcp/queries/)            | [Query](/api/tcp/queries/#query-commands)                                                                                                                         | Read jobs, states, results, progress, child values and counts                                            |
| [Control & Limits](/api/tcp/control/)   | [Control](/api/tcp/control/#control-commands), [Rate Limiting](/api/tcp/control/#rate-limiting-commands), [Queue Config](/api/tcp/control/#queue-config-commands) | Job and queue control, rate and concurrency limits, job groups, deduplication keys, stall and DLQ config |
| [Dead Letter Queue](/api/tcp/dlq/)      | [DLQ](/api/tcp/dlq/#dlq-commands)                                                                                                                                 | Inspect, retry, purge and remove dead-letter entries; re-queue completed jobs                            |
| [Cron](/api/tcp/cron/)                  | [Cron](/api/tcp/cron/#cron-commands)                                                                                                                              | Create, update, list, read and delete cron schedules                                                     |
| [Flows](/api/tcp/flows/)                | [Flow Dependency](/api/tcp/flows/#flow-dependency-commands)                                                                                                       | Parent/child dependency commands used by FlowProducer                                                    |
| [Monitoring](/api/tcp/monitoring/)      | [Monitoring](/api/tcp/monitoring/#monitoring-commands), [Dashboard](/api/tcp/monitoring/#dashboard-commands)                                                      | Health, protocol negotiation, stats, metrics, heartbeats and dashboard snapshots                         |
| [Workers & Webhooks](/api/tcp/workers/) | [Worker](/api/tcp/workers/#worker-commands), [Webhook](/api/tcp/workers/#webhook-commands)                                                                        | Worker registration and webhooks                                                                         |

## Queue Name Validation

Queue names must satisfy the following constraints:

- Not empty and at most 256 characters
- Only alphanumeric characters, underscores, dashes, dots, and colons: `[a-zA-Z0-9_\-.:]+`

## Job Data Limits

Job data payloads are limited to **10 MB** when serialized.

## Command Summary

| Category       | Command                                                                      | Description                                  |
| -------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| **Core**       | [`PUSH`](/api/tcp/jobs/#push)                                                | Add a job to a queue                         |
|                | [`PUSHB`](/api/tcp/jobs/#pushb)                                              | Batch push multiple jobs                     |
|                | [`PUSHF`](/api/tcp/jobs/#pushf)                                              | Atomically commit a flow graph               |
|                | [`PULL`](/api/tcp/jobs/#pull)                                                | Pull next job (supports long poll and locks) |
|                | [`PULLB`](/api/tcp/jobs/#pullb)                                              | Batch pull jobs                              |
|                | [`ACK`](/api/tcp/jobs/#ack)                                                  | Acknowledge job completion                   |
|                | [`ACKB`](/api/tcp/jobs/#ackb)                                                | Batch acknowledge                            |
|                | [`FAIL`](/api/tcp/jobs/#fail)                                                | Mark job as failed                           |
| **Query**      | [`GetJob`](/api/tcp/queries/#getjob)                                         | Get job by ID                                |
|                | [`GetState`](/api/tcp/queries/#getstate)                                     | Get job state                                |
|                | [`GetResult`](/api/tcp/queries/#getresult)                                   | Get job result                               |
|                | [`GetJobs`](/api/tcp/queries/#getjobs)                                       | List jobs with filtering                     |
|                | [`GetJobCounts`](/api/tcp/queries/#getjobcounts)                             | Count jobs by state                          |
|                | [`GetCountsPerPriority`](/api/tcp/queries/#getcountsperpriority)             | Count jobs by priority                       |
|                | [`GetJobByCustomId`](/api/tcp/queries/#getjobbycustomid)                     | Look up job by custom ID                     |
|                | [`Count`](/api/tcp/queries/#count)                                           | Queued job count for a queue                 |
|                | [`GetProgress`](/api/tcp/queries/#getprogress)                               | Get job progress                             |
|                | [`GetChildrenValues`](/api/tcp/queries/#getchildrenvalues)                   | Get child job return values                  |
|                | [`GetQueueLimits`](/api/tcp/control/#getqueuelimits)                         | Read live queue rate/concurrency status      |
|                | [`GetDeduplicationJobId`](/api/tcp/control/#deduplication-introspection)     | Resolve a queue-scoped deduplication key     |
| **Control**    | [`Cancel`](/api/tcp/control/#cancel)                                         | Cancel a job                                 |
|                | [`Progress`](/api/tcp/control/#progress)                                     | Update job progress                          |
|                | [`Update`](/api/tcp/control/#update)                                         | Update job data                              |
|                | [`ChangePriority`](/api/tcp/control/#changepriority)                         | Change job priority                          |
|                | [`Promote`](/api/tcp/control/#promote)                                       | Move delayed job to waiting                  |
|                | [`MoveToDelayed`](/api/tcp/control/#movetodelayed)                           | Move active job to delayed                   |
|                | [`MoveToWaitingChildren`](/api/tcp/control/#movetowaitingchildren)           | Park an active job for children              |
|                | [`ChangeDelay`](/api/tcp/jobs/#changedelay)                                  | Change a delayed job's delay                 |
|                | [`MoveToWait`](/api/tcp/jobs/#movetowait)                                    | Move a job back to waiting                   |
|                | [`PromoteJobs`](/api/tcp/jobs/#promotejobs)                                  | Promote all delayed jobs in a queue          |
|                | [`Discard`](/api/tcp/control/#discard)                                       | Move job to DLQ                              |
|                | [`WaitJob`](/api/tcp/control/#waitjob)                                       | Wait for job completion                      |
|                | [`ExtendLock`](/api/tcp/jobs/#extendlock)                                    | Extend a job lock                            |
|                | [`ExtendLocks`](/api/tcp/jobs/#extendlocks)                                  | Extend job locks (batch)                     |
|                | [`RemoveDeduplicationKey`](/api/tcp/control/#deduplication-introspection)    | Release a queue-scoped deduplication key     |
|                | [`RemoveJobDeduplicationKey`](/api/tcp/control/#deduplication-introspection) | Release only a job-owned key                 |
|                | [`Pause`](/api/tcp/control/#pause)                                           | Pause a queue                                |
|                | [`Resume`](/api/tcp/control/#resume)                                         | Resume a queue                               |
|                | [`IsPaused`](/api/tcp/control/#ispaused)                                     | Check if queue is paused                     |
|                | [`Drain`](/api/tcp/control/#drain)                                           | Remove all waiting/delayed jobs              |
|                | [`Obliterate`](/api/tcp/control/#obliterate)                                 | Remove all queue data                        |
|                | [`Clean`](/api/tcp/control/#clean)                                           | Remove old jobs                              |
|                | [`ListQueues`](/api/tcp/control/#listqueues)                                 | List all queues                              |
| **DLQ**        | [`Dlq`](/api/tcp/dlq/#dlq)                                                   | Get DLQ entries                              |
|                | [`GetDlqStats`](/api/tcp/dlq/#getdlqstats)                                   | Get aggregate DLQ statistics                 |
|                | [`RetryDlq`](/api/tcp/dlq/#retrydlq)                                         | Retry DLQ jobs                               |
|                | [`PurgeDlq`](/api/tcp/dlq/#purgedlq)                                         | Clear DLQ                                    |
|                | [`RemoveDlqJob`](/api/tcp/dlq/#removedlqjob)                                 | Permanently delete one DLQ job               |
|                | [`RetryCompleted`](/api/tcp/dlq/#retrycompleted)                             | Re-queue completed jobs                      |
| **Cron**       | [`Cron`](/api/tcp/cron/#cron)                                                | Create/update cron schedule                  |
|                | [`CronDelete`](/api/tcp/cron/#crondelete)                                    | Delete cron schedule                         |
|                | [`CronList`](/api/tcp/cron/#cronlist)                                        | List cron schedules                          |
|                | [`CronGet`](/api/tcp/cron/#cronget)                                          | Get cron schedule by name                    |
| **Monitoring** | [`Ping`](/api/tcp/monitoring/#ping)                                          | Health check                                 |
|                | [`Hello`](/api/tcp/monitoring/#hello)                                        | Protocol negotiation                         |
|                | [`Stats`](/api/tcp/monitoring/#stats)                                        | Server statistics                            |
|                | [`Metrics`](/api/tcp/monitoring/#metrics)                                    | Detailed metrics                             |
|                | [`TrimEvents`](/api/tcp/monitoring/#trimevents)                              | Trim one queue's lifecycle journal           |
|                | [`Prometheus`](/api/tcp/monitoring/#prometheus)                              | Prometheus-format metrics                    |
|                | [`StorageStatus`](/api/tcp/monitoring/#storagestatus)                        | Get storage/disk health status               |
|                | [`Heartbeat`](/api/tcp/monitoring/#heartbeat)                                | Worker heartbeat                             |
|                | [`JobHeartbeat`](/api/tcp/monitoring/#jobheartbeat)                          | Job heartbeat (stall prevention)             |
|                | [`JobHeartbeatB`](/api/tcp/monitoring/#jobheartbeatb)                        | Batch job heartbeat                          |
| **Workers**    | [`RegisterWorker`](/api/tcp/workers/#registerworker)                         | Register a worker                            |
|                | [`UnregisterWorker`](/api/tcp/workers/#unregisterworker)                     | Unregister a worker                          |
|                | [`ListWorkers`](/api/tcp/workers/#listworkers)                               | List workers                                 |
| **Webhooks**   | [`AddWebhook`](/api/tcp/workers/#addwebhook)                                 | Register a webhook                           |
|                | [`RemoveWebhook`](/api/tcp/workers/#removewebhook)                           | Remove a webhook                             |
|                | [`ListWebhooks`](/api/tcp/workers/#listwebhooks)                             | List webhooks                                |
|                | [`SetWebhookEnabled`](/api/tcp/jobs/#setwebhookenabled)                      | Enable/disable a webhook                     |
| **Rate**       | [`RateLimit`](/api/tcp/control/#ratelimit)                                   | Set queue rate limit                         |
|                | [`RateLimitClear`](/api/tcp/control/#ratelimitclear)                         | Clear queue rate limit                       |
|                | [`SetConcurrency`](/api/tcp/control/#setconcurrency)                         | Set queue concurrency limit                  |
|                | [`ClearConcurrency`](/api/tcp/control/#clearconcurrency)                     | Clear concurrency limit                      |
| **Job groups** | [`GetGroupJobsCount`](/api/tcp/control/#job-group-controls-and-getters) / [`GetGroupsJobsCount`](/api/tcp/control/#job-group-controls-and-getters) | Read grouped backlog                         |
|                | [`GetGroupActiveCount`](/api/tcp/control/#job-group-controls-and-getters)    | Read active jobs in one group                |
|                | [`SetGroupRateLimit`](/api/tcp/control/#job-group-controls-and-getters) / [`GetGroupRateLimit`](/api/tcp/control/#job-group-controls-and-getters) / [`RemoveGroupRateLimit`](/api/tcp/control/#job-group-controls-and-getters) | Manage one group's rate override             |
|                | [`GetGroupRateLimitTtl`](/api/tcp/control/#job-group-controls-and-getters)   | Read one group's fixed-window TTL            |
|                | [`SetGroupConcurrency`](/api/tcp/control/#job-group-controls-and-getters) / [`GetGroupConcurrency`](/api/tcp/control/#job-group-controls-and-getters) / [`RemoveGroupConcurrency`](/api/tcp/control/#job-group-controls-and-getters) | Manage one group's concurrency override      |
|                | [`PauseGroup`](/api/tcp/control/#job-group-controls-and-getters) / [`ResumeGroup`](/api/tcp/control/#job-group-controls-and-getters) / [`IsGroupPaused`](/api/tcp/control/#job-group-controls-and-getters) | Control and read one group's pause state     |
|                | [`RateLimitGroup`](/api/tcp/control/#job-group-controls-and-getters)         | Install an immediate manual group deadline   |
| **Config**     | [`SetStallConfig`](/api/tcp/control/#setstallconfig--getstallconfig)         | Set per-queue stall config                   |
|                | [`GetStallConfig`](/api/tcp/control/#setstallconfig--getstallconfig)         | Get per-queue stall config                   |
|                | [`SetDlqConfig`](/api/tcp/control/#setdlqconfig--getdlqconfig)               | Set per-queue DLQ config                     |
|                | [`GetDlqConfig`](/api/tcp/control/#setdlqconfig--getdlqconfig)               | Get per-queue DLQ config                     |
| **Logs**       | [`AddLog`](/api/tcp/jobs/#addlog)                                            | Add job log entry                            |
|                | [`GetLogs`](/api/tcp/jobs/#getlogs)                                          | Get job logs                                 |
|                | [`ClearLogs`](/api/tcp/jobs/#clearlogs)                                      | Clear job logs                               |
| **Flow**       | [`UpdateParent`](/api/tcp/flows/#updateparent)                               | Update a child's parent reference            |
|                | [`GetFailedChildrenValues`](/api/tcp/flows/#getfailedchildrenvalues)         | Failed children values                       |
|                | [`GetIgnoredChildrenFailures`](/api/tcp/flows/#getignoredchildrenfailures)   | Ignored children failures                    |
|                | [`RemoveChildDependency`](/api/tcp/flows/#removechilddependency)             | Remove a child's parent dependency           |
|                | [`RemoveUnprocessedChildren`](/api/tcp/flows/#removeunprocessedchildren)     | Remove unprocessed children                  |
| **Dashboard**  | [`DashboardOverview`](/api/tcp/monitoring/#dashboardoverview)                | Aggregated dashboard snapshot                |
|                | [`DashboardQueues`](/api/tcp/monitoring/#dashboardqueues)                    | All queues with stats                        |
|                | [`DashboardQueue`](/api/tcp/monitoring/#dashboardqueue)                      | Single queue detail                          |
| **System**     | [`CompactMemory`](/api/tcp/jobs/#compactmemory)                              | Trigger memory compaction                    |
| **Events**     | [`SubscribeEvents`](#queue-event-frames)                                     | Stream one queue's events on this connection |
|                | [`UnsubscribeEvents`](#queue-event-frames)                                   | Stop this connection's event stream          |
| **Auth**       | [`Auth`](#authentication)                                                    | Authenticate connection                      |

:::tip[Related]

- [HTTP API Reference](/api/http/) - REST API alternative
- [TypeScript Types](/api/types/) - Type definitions
- [TCP Protocol Architecture](/architecture/tcp-protocol/) - Protocol internals
  :::
