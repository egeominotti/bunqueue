# bunqueue vs BullMQ + Redis

A reproducible benchmark of bunqueue against BullMQ on Redis, at pinned versions,
with the broker and the clients on separate CPU cores, open-loop latency
measurement and exact-delivery checks on every run.

```bash
cd bench/vs-bullmq
bun install --frozen-lockfile
bun src/run.ts            # full run (about 70 minutes)
bun src/run.ts --quick    # small sizes, one repetition, to check the harness
```

Results land in `results/<timestamp>/`: `raw.jsonl` (every run, warm-up included),
`summary.json` (median, min and max per scenario) and `environment.json` (hardware,
kernel, governor, runtime and package versions). Requires Linux, Docker, Bun and
Node.js, and `taskset`.

## What is compared

| | Version | Notes |
| --- | --- | --- |
| bunqueue | 2.9.20 (npm) | server started with `bunqueue start`, clients from `bunqueue/client` on Bun |
| BullMQ | 6.4.2 (npm) | clients on Node.js 24 and on Bun, both reported |
| Redis | 8.10.2 (official image) | host networking, single instance |
| ioredis | 6.0.0 | BullMQ's connection library (peer dependency) |

Both queues use their documented defaults. The only settings passed are the ones a
scenario varies (concurrency, attempts, delay) plus `removeOnComplete` and
`removeOnFail` on every job, the common production setting for high-volume queues
in both libraries. bunqueue is reported twice for worker scenarios: with its
defaults, where an idle worker re-polls after `drainDelay` (50 ms), and with
`pollTimeout: 5000`, its documented long-poll mode. BullMQ workers long-poll by
default (a blocking Redis call), so the second configuration is the like-for-like
comparison for latency.

The bunqueue server runs with `RATE_LIMIT_WINDOW_MS=0`. Its default per-connection
request limit (10,000 per minute) protects a shared server from a misbehaving
client; Redis has no equivalent, and the limit would cap any throughput test.

## Storage modes

| Mode | bunqueue | Redis |
| --- | --- | --- |
| memory | in-memory engine (no data path) | `--save "" --appendonly no` |
| durable | SQLite in WAL mode (`--data-path`) | AOF with `--appendfsync everysec` |

Both durable stores write to the same local disk.

## Machine discipline

- One broker runs at a time, pinned to two physical cores (`taskset`/`--cpuset-cpus`
  `2,3,18,19`). Producers and workers run on the other CCD (`8-15,24-31`), so the
  broker never shares a core or an L3 cache with its clients.
- Each broker is started fresh for each storage mode, and again before the memory
  measurement. Every run uses a new queue name and a fresh client process.
- Every scenario/configuration runs once as warm-up (discarded) and five times
  measured; the tables report the median with the min and max.

## Scenarios

| Scenario | What it measures |
| --- | --- |
| `enqueue-serial` | One `add` at a time: round-trip cost, with per-call latency percentiles |
| `enqueue-concurrent` | 64 `add` calls in flight |
| `enqueue-bulk` | `addBulk` in batches of 100 |
| `drain-{1,4,8}x50` | A prefilled backlog drained by 1, 4 or 8 worker processes with 50 concurrency each; timed until the queue holds nothing waiting, active or delayed |
| `latency-{1k,5k,10k}` | Open-loop producer at a fixed rate for 15 s, two worker processes; pickup latency is measured from each job's *scheduled* send time, so a broker that falls behind shows up as latency instead of lowering the offered load |
| `delayed` | 20,000 jobs due 1-4 s after they are added: how late each one starts |
| `retry` | Every job fails twice and succeeds on its third attempt (`attempts: 3`, no backoff) |
| `memory-1m` | Broker resident memory idle and with a 1,000,000-job backlog |

Every consuming scenario checks exact delivery: each accepted job is processed
exactly once (three times in `retry`). A run that loses or duplicates a job fails
instead of reporting a number.
