# Debugging and Profiling (agents)

Debug endpoints, memory debugging and the CPU/heap profiling rules, moved verbatim
from the root `CLAUDE.md`; this introduction is new. `AGENTS.md` carried the same
five profiling rules in equivalent wording; its explicit sentences are kept at the
end ([From AGENTS.md](#from-agentsmd)). Benchmarks follow [Benchmarks are native](../testing.md#benchmarks-are-native)
and [Benchmarking and Performance Evidence](../features/benchmarks.md). Index:
[docs/agents/README.md](./README.md).

## Debug Endpoints

```bash
curl http://localhost:6790/health     # Health + memory
curl http://localhost:6790/heapstats  # Object breakdown
curl -X POST http://localhost:6790/gc # Force GC
```

## Memory Debugging

```typescript
import { heapStats } from 'bun:jsc';
Bun.gc(true);
const stats = heapStats();
console.log(stats.objectCount, stats.objectTypeCounts);

// Check internal collections
const mem = queueManager.getMemoryStats();
// jobIndex, completedJobs, processingTotal, queuedTotal, temporalIndexTotal
```

## CPU and Memory Profiling

- Profile a representative full workload for long enough to collect meaningful
  samples; a smoke run only validates the harness. Use fresh process/state and a
  separate unprofiled baseline. Profiled timings are diagnostic, not publishable
  benchmark results.
- Generate both CPU views in one native run:
  `bun --cpu-prof --cpu-prof-md --cpu-prof-dir=<artifact-dir> <workload>`.
  Triage self/total time and callers in Markdown, then inspect the `.cpuprofile`
  in Chrome DevTools or VS Code.
- Generate heap formats in separate native runs because `--heap-prof-md`
  overrides `--heap-prof` when combined:
  `bun --heap-prof --heap-prof-dir=<artifact-dir> <workload>` and
  `bun --heap-prof-md --heap-prof-dir=<artifact-dir> <workload>`. Exercise cleanup
  and exit normally so the snapshots are written.
- Prove leaks with repeated workload/cleanup cycles at equivalent checkpoints.
  After `Bun.gc(true)`, record `bun:jsc` `heapStats()`, `process.memoryUsage()`, and
  `QueueManager.getMemoryStats()`; compare retained types and retainer chains, not
  RSS alone.
- Bun has separate JavaScriptCore and native heaps. Use snapshots/stats for JS
  retention and opt-in `Bun.unsafe.mimallocDump()` for native allocation. Never
  expose profiles through an unauthenticated endpoint: snapshots may contain job
  payloads or secrets. Keep outputs under ignored `artifacts/`.

## From AGENTS.md

Sentences of the `AGENTS.md` profiling rules that the list above words differently,
moved verbatim:

- RSS growth alone is not proof of a leak.
- Never expose profiling as an unauthenticated endpoint; snapshots may contain job
  payloads or secrets. Store outputs only under ignored `artifacts/`.
