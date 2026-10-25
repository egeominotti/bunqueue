---
name: bunqueue-dev
description: Internal skill for contributing to bunqueue - architecture, testing, code conventions, and development workflow
disable-model-invocation: false
user-invocable: false
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

# bunqueue Development Guide

You are working on **bunqueue**, a high-performance job queue for Bun with SQLite persistence.

## Architecture

bunqueue uses a sharded priority queue architecture:
- **Shards**: Auto-detected from CPU cores (power of 2, max 64). Jobs are assigned via `fnv1aHash(queue) & SHARD_MASK`
- **Persistence**: SQLite in WAL mode with a 10ms WriteBuffer for batching writes
- **Transport**: TCP (msgpack) on port 6789, HTTP on port 6790
- **Two modes**: Embedded (in-process) and TCP (client-server)

### Request Flow
1. **PUSH**: Client -> TcpPool -> TcpServer -> QueueManager -> Shard -> PriorityQueue -> WriteBuffer -> SQLite
2. **PULL**: Client -> TcpServer -> QueueManager -> Shard -> PriorityQueue.pop()
3. **ACK**: Client -> TcpServer -> AckBatcher -> Shard.complete() -> jobResults (LRU)
4. **FAIL**: Client -> TcpServer -> Shard.fail() -> retry (backoff) OR -> DLQ

### Directory Structure
```
src/
  cli/              # CLI interface
  client/           # SDK (Queue, Worker, FlowProducer, Bunqueue)
    queue/          # Queue with DLQ, stall detection
    worker/         # Worker with heartbeat, ack batching
    tcp/            # Connection pool, reconnection
    workflow/       # Workflow Engine (Workflow DSL, Engine, Executor, Store)
  domain/           # Pure business logic
    queue/          # Shard, PriorityQueue, DlqShard, UniqueKeyManager
  application/      # Use cases and managers
    operations/     # push, pull, ack, query, queueControl
  infrastructure/   # Persistence, server, scheduler, backup
  shared/           # Utilities (hash, lock, lru, skipList, minHeap)
```

### Workflow Engine
Located in `src/client/workflow/`. Pure consumer layer on bunqueue (no core modifications).
- **workflow.ts** — Fluent DSL: `.step()`, `.branch()`, `.path()`, `.waitFor()`
- **engine.ts** — Public facade: register, start, signal, getExecution, close
- **executor.ts** — Core logic: step execution, branching, compensation, signals
- **store.ts** — SQLite persistence for execution state (workflow_executions table)
- **types.ts** — StepContext, Execution, StepJobData, EngineOptions, etc.
- Export: `import { Workflow, Engine } from 'bunqueue/workflow'`

## Code Conventions

- **MAX 300 lines per file** - split if larger
- One concern per file (Single Responsibility)
- Export only what's needed
- Lock hierarchy: `jobIndex` -> `completedJobs` -> `shards[N]` -> `processingShards[N]`

## Testing (MANDATORY before any commit)

Run tests in fresh isolated OrbStack Machines on the Mac's native architecture.
The canonical gate is Ubuntu 24.04 (4 CPUs, request 16 GiB memory, 32 GiB disk);
every release also uses Debian 13 on the same native architecture. On Apple
Silicon use `arm64`; GitHub Actions provides the independent native `amd64`
gate. A Rosetta-translated `amd64` Machine is diagnostic only. Create Machines
with `--isolated --isolate-network`, never mount host paths or forward
credentials, transfer only a sanitized worktree snapshot, pin Bun to the CI
version, record effective cgroup limits, and delete each Machine after copying
its logs. Direct macOS-host runs are diagnostic only. Machine runs supplement
the mandatory Docker sandbox and never replace it.

```bash
bun test --parallel=4                   # Unit tests (four isolated file workers)
bun scripts/tcp/run-all-tests.ts        # TCP integration tests (~50 suites)
bun scripts/embedded/run-all-tests.ts   # Embedded integration tests (~35 suites)
bun run test:sandbox                    # Additional container isolation gate
```

All product suites and the sandbox must pass. No exceptions.

## Bug Fixing Process

NEVER fix a bug directly. Always:
1. Write a test that reproduces the bug
2. Launch subagents to fix the bug
3. Prove the fix with a passing test

## Publishing

Version bumps and publication happen only when the user explicitly asks for a
release. Never run `bun publish` or `npm publish` locally: npm packages are
published only by the CI release jobs through npm trusted publishing (OIDC,
environment `npm`). Every commit updates `docs/src/content/docs/changelog.md`.

## Release blog posts (MANDATORY for every release)

Every release gets a professional blog post at
`/blog/bunqueue-vX-Y-Z/`, in the style of Bun's release posts (bun.com/blog).
The release-preparation commit (the one that dates the changelog section) must
include it:

1. Run `bun docs/scripts/generate-release-posts.ts`. It writes a draft post for
   every dated changelog section (`docs/src/content/docs/blog/bunqueue-vX-Y-Z.md`)
   with the install/upgrade box, feature sections, bugfixes and contributors.
2. Rewrite the new release's draft by hand into a professional article: a
   description that leads with the user-visible outcome and real numbers; a
   short intro on why the release matters; one `##` section per notable change,
   titled as a claim ("Dashboards no longer cost a full scan every 10 ms") with
   prose plus before/after tables or code; then "Other improvements",
   "Bugfixes", "Thanks to N contributors!" and the link to the previous
   release. Every fact and figure must come from the changelog or real
   measurements; never invent numbers, quotes or features.
3. Delete the `<!-- Generated from changelog.md ... -->` marker from the
   rewritten post. The generator never overwrites a post without the marker.
4. After the release is tagged and published, run
   `bun docs/scripts/generate-release-posts.ts --refresh` (contributors, npm,
   Docker and GitHub release data in `docs/src/data/releaseMeta.json`), then
   regenerate and update the hand-written post's install box and contributors.

CI runs `generate-release-posts.ts --check`: a stale or missing post fails the
docs job. The GitHub release body links to the post, the blog index and RSS
list it, and the home page announces the newest release post.
