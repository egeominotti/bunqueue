# MCP evaluation

Run from the repository root with Bun and installed development dependencies:

```sh
bun scripts/mcp-eval/task-eval.ts
bun scripts/mcp-eval/catalog-measurement.ts
```

The first command emits a JSON report and exits 1 when any scenario fails (or an
empty evaluation is aggregated). It exercises the real MCP server/client and
five independently verified tasks on fresh embedded and TCP backends. Each owns
unique queues/temporary SQLite state/dynamic broker ports and cleanup. Run in a
standalone process, sequentially, without an application's active embedded
manager. No model/provider credentials or paid calls are used.

Per-scenario results include checks, passed, driver, mode, tool-call count,
elapsedMs, complete serialized responseBytes and optional external-driver usage.
Elapsed time includes startup/cleanup. Response bytes include tools/list and
tools/call results; calls count tools/call only. Null completed results, permanent
failure/unknown, full bounded paging/invalid limits, observed diagnosis/limits
and guard non-execution are graded with separate backend reads. Driver success
flags cannot replace the assertions.

`TaskDriver` in `task-types.ts` is an opt-in extension point:

```typescript
import { runTaskEvaluation, aggregateTaskResults } from './task-eval';
import type { TaskDriver } from './task-types';

// Implement externally; choose provider/credentials/approval/deadlines explicitly.
declare const driver: TaskDriver;
const results = await runTaskEvaluation({ driver, modes: ['tcp'] });
process.exitCode = aggregateTaskResults(results).exitCode;
```

The default driver is a hand-written deterministic script. Its passing score is
offline functional evidence, not an LLM success rate, routing score or provider
benchmark. An interface with no external run supplies no LLM performance data.
External drivers must bound their own provider execution/cancellation. Fixtures
are transparent; new held-out tasks are needed for meaningful generalization.

The second command measures current complete serialized descriptors and actual
disclosures, including metadata/input/output schemas. UTF-8 bytes are measured
directly; estimated tokens are ceil(bytes/4), not model tokenizer results. Default
primary tools, initial dynamic discovery and optional workflows are separate.
See [RESULTS.md](RESULTS.md) for measurements and their environment.

`toolset-routing.ts` / `toolset-routing.json` retain the historical 72-request
routing corpus. `--lexical` is offline; default model mode calls the configured
decision provider and requires explicit opt-in. Routing to a toolset does not
show that the user task was completed. No model routing run is needed by the
offline task runner.
