---
name: bunqueue-dev
description: "Orientation map of the bunqueue repository for contributors. Use when asked how bunqueue works internally or where code lives (request flow of PUSH, PULL and ACK, shards, lock order, embedded versus TCP mode, Workflow Engine files), when planning or reviewing a feature or a refactor of the source, or when unsure which bunqueue skill or reference page covers a task. Load it before searching the source. Skip it for a bug fix, a gate, a Machine run, a release or a session: load the bunqueue-* skill that owns the task instead. Not for applications that use bunqueue as a library."
license: MIT
metadata:
  short-description: Orientation and routing for bunqueue contributors
---

# bunqueue development guide

bunqueue is a high-performance job queue for Bun with SQLite persistence. The
mandatory rules are in [CLAUDE.md](../../../CLAUDE.md) (Claude Code) and
[AGENTS.md](../../../AGENTS.md) (Codex); read the one for your agent completely before
changing anything. This skill is a map: what the code looks like and where each
procedure lives.

## Which skill or page

| Task | Go to |
| --- | --- |
| Start, resume, track or hand off a session; edit `feature_list.json` or `progress.md` | bunqueue-working-sessions ([skill](../bunqueue-working-sessions/SKILL.md)) |
| A bug, regression or failing behavior to fix | bunqueue-fixing-bugs ([skill](../bunqueue-fixing-bugs/SKILL.md)) |
| Which gates to run, reading sandbox artifacts, a failing gate, a post-gate change, watching CI after a push | bunqueue-running-gates ([skill](../bunqueue-running-gates/SKILL.md)) |
| Ubuntu and Debian OrbStack Machine evidence | bunqueue-running-machine-gates ([skill](../bunqueue-running-machine-gates/SKILL.md)) |
| A release the user explicitly asked for | bunqueue-releasing ([skill](../bunqueue-releasing/SKILL.md)) |
| Working through the work items unattended, when the user explicitly asked for it | bunqueue-working-autonomously ([skill](../bunqueue-working-autonomously/SKILL.md)) |
| Architecture, env vars, TCP commands, CLI, schema | [docs/agents/project-reference.md](../../../docs/agents/project-reference.md) |
| Simple Mode, Workflow Engine, Client SDK options | [docs/agents/client-reference.md](../../../docs/agents/client-reference.md) |
| Debug endpoints, CPU and heap profiling | [docs/agents/debugging.md](../../../docs/agents/debugging.md) |
| Test isolation, the gates and their rationale | [docs/testing.md](../../../docs/testing.md) |
| Engineering reference (authoritative) | [docs/README.md](../../../docs/README.md), [docs/architecture.md](../../../docs/architecture.md), [docs/data-model.md](../../../docs/data-model.md) |

## Architecture

A sharded priority-queue broker:

- **Shards**: auto-detected from CPU cores (power of 2, max 64); a queue maps to
  `fnv1aHash(queue) & SHARD_MASK`.
- **Persistence**: SQLite in WAL mode behind a 10 ms WriteBuffer that batches writes;
  `durable: true` bypasses it.
- **Transport**: TCP (msgpack) on port 6789, HTTP on port 6790, native TLS on both when
  `TLS_CERT_FILE` and `TLS_KEY_FILE` are set.
- **Two modes**: embedded (in-process) and TCP (client-server).

Request flow:

1. **PUSH**: Client -> TcpPool -> TcpServer -> QueueManager -> Shard -> PriorityQueue
   -> WriteBuffer -> SQLite
2. **PULL**: Client -> TcpServer -> QueueManager -> Shard -> PriorityQueue.pop()
3. **ACK**: Client -> TcpServer -> AckBatcher -> Shard.complete() -> jobResults (LRU)
4. **FAIL**: Client -> TcpServer -> Shard.fail() -> retry (backoff) or DLQ

## Source layout

```text
src/
  cli/              CLI interface
  client/           SDK: Queue, Worker, FlowProducer, Bunqueue (Simple Mode)
    queue/          Queue with DLQ, stall detection
    worker/         Worker with heartbeat, ack batching
    tcp/            connection pool, reconnection
    workflow/       Workflow Engine: Workflow DSL, Engine, Executor, Store
  domain/           pure business logic
    queue/          Shard, PriorityQueue, DlqShard, UniqueKeyManager
  application/      use cases and managers
    operations/     push, pull, ack, query, queueControl
  infrastructure/   persistence, server, scheduler, backup
  shared/           utilities: hash, lock, lru, skipList, minHeap
```

The Workflow Engine in `src/client/workflow/` is a pure consumer of the queue (no core
changes): `workflow.ts` is the fluent DSL (`.step()`, `.branch()`, `.path()`,
`.waitFor()`), `engine.ts` the public facade, `executor.ts` step execution, branching,
compensation and signals, `store.ts` the SQLite execution state, `types.ts` the shared
types. It is exported as `bunqueue/workflow`.

## Code conventions

- At most 300 lines per source file; split instead of growing one. One concern per
  file, export only what is needed.
- Lock hierarchy: `jobIndex` -> `completedJobs` -> `shards[N]` -> `processingShards[N]`;
  read first, then lock, release in `finally`, and never `await` inside a shard's
  synchronous critical section.
- Queue invariants (heap membership, `jobIndex`, processing maps, counters, temporal
  indexes, group ownership, concurrency slots) transition exactly once.
- Type check with `bun check` and format with `bun fmt` only, through the package
  scripts.

## Gotchas

- `.claude/skills/<name>` are relative symlinks into `.agents/skills/`. On Windows Git
  checks symlinks out as plain text files unless symlinks are enabled, and Claude Code
  then finds no skill: clone with `git clone -c core.symlinks=true` (symlinks need
  Windows Developer Mode or an elevated shell). A clone made without it needs a fresh
  clone with the setting; the canonical `.agents/skills/` is unaffected.
- The repository root also holds `skills/bunqueue/` and `agents/`: the Claude Code
  plugin for people who use bunqueue in their applications. They are product
  documentation, not contributor instructions; contributor skills live in
  `.agents/skills/`.
- The reference pages under `docs/agents/` are summaries. When one disagrees with the
  engineering reference or the code, the code and `docs/` win, and the summary is fixed
  in the same change.
- Every code change updates `/docs` and the changelog in the same change-set; a change
  is not complete while its documentation is stale.
