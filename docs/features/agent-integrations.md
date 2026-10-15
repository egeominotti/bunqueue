# Optional Agent Integrations

`bunqueue/agents` is an optional Bun-only integration boundary in `src/agents/`.
It imports no provider SDK, queue manager, workflow engine, or transport. Its own
SQLite file keeps session checkpoints, redacted progress and external effect
outcomes independent of queue/workflow persistence. It does not start a worker,
change scheduling, or change engine compensation rules.

## Published package contract

The current versioned API reference includes `src/agents/index.ts` and the journal's
signature types, so `AgentJournal.getEffect()` links to the documented `EffectRecord`
shape. TypeDoc keeps private broker wait/lease/timer aliases outside the public
reference rather than advertising additional queue APIs.

The optional `./agents` export resolves to `dist/agents/index.js` under Bun and
ships `dist/agents/index.d.ts` for TypeScript consumers. It joins the existing
root, client, queue, workflow, MCP and package-manifest exports. Node resolves
the shared Bun-only guard with an actionable runtime requirement.

`test/package-consumer-smoke.test.ts` builds and unpacks the actual tarball into
an isolated consumer layout, then imports `AgentJournal`, `consumeAgentTurn`,
`runAgentEffect` and `mapClaudeMessages` alongside the existing public APIs.
Only the manifest's declared runtime dependency, `msgpackr`, is provided; no
provider SDK is installed in the consumer. Strict compilation checks the packed
`AgentRunIdentity` and generic `AgentTurnOptions` declarations alongside the
existing group types. MCP retains its separate optional-peer install error,
and the packed agents Node guard is checked when native Node is available. The
fixture probes `process.versions.bun` to distinguish native Node from Bun's
Node-named fallback executable; failed or unexpected probe results fail the test.

## Public interface

`AgentJournal(path, options?)` requires a dedicated file. It refuses `:memory:`,
foreign files and unsupported schema versions. Close it after all users stop;
repeated `close()` calls are safe. Every identity is a nonempty string of at most
4096 UTF-8 bytes. Effects also require a caller's stable business `callId`.

| Operation | Contract |
| --- | --- |
| `checkpointSession(executionId, stepId, sessionId)` | Durable run/step upsert |
| `getSession(executionId, stepId)` | ID or null; caller wires provider resume options |
| `append(executionId, stepId, event)` | Commit normalized progress/session checkpoint; return monotonic global cursor |
| `replay(executionId, { after?, limit? })` | Consistent snapshot of events, nextCursor and per-run retention gap |
| `consumeAgentTurn(source, options?)` | Consume normalized async events; return parsed output/session only on terminal success |
| `mapClaudeMessages(messages)` | Structural Claude init/result adapter excluding raw provider payloads |
| `runAgentEffect({ journal, executionId, stepId, callId, invoke, reconcile? })` | Atomically claim pending work, replay completed result, refuse uncertain repetition |
| `agentEffectKey({ executionId, stepId }, callId)` | SHA-256 of JSON identity tuple, stable across retries |

The consumer accepts a structural `{ parse(value): T }` schema without provider
imports. A journal requires explicit run/step identity. Session events commit
before the iterator advances. Usage, progress and tool lifecycle are supported;
failure/cancelled/needs_input are terminal failures. Exhaustion or transport
errors throw `AgentTurnError('interrupted')`. Parsing errors throw invalid_output
and record failure rather than success. Needs-input requires caller approval and
state handling; it is not automatically a workflow gate.

The Claude adapter prefers explicit `structured_output`, preserving null, false,
zero and empty strings. It falls back to ordinary result text only when structured
output is absent or undefined. Caller schemas validate that exact normalized
value; a null-accepting schema can therefore accept a successful structured null.
Offline adapter fixtures exercise the SDK's optional unknown-shaped output
contract without claiming that a live provider emitted these values.

Failure-event persistence is best effort after a terminal failure. A byte cap,
closed journal or database write error cannot replace the original AgentTurnError
classification or cause; the secondary exception is exposed as `recordingError`.
This applies to provider failure/needs-input/cancelled events as well as schema,
transport and abort failures. Successful turns still require durable recording.

An AbortSignal races a blocked iterator and throws typed cancellation. The caller
supplies a callback invoking the provider cancellation API. Cancellation/cleanup
rejection handlers prevent unhandled rejections; iterator return is not awaited,
because it may block behind an outstanding read. A provider that ignores abort
can continue remote work. Already-issued operations can remain uncertain.

## SQLite ownership and durability

`journal-database.ts` reserves new files exclusively with mode 0600, commits the
schema, application ID `0x4251414a` and user version `1` into the main file before
enabling WAL. Filesystem-only preflight checks the main header and committed
page-one WAL frames, using the latest committed metadata rather than superseded
or uncommitted frames. Foreign/unsupported files are refused without SQLite
opening, recovering, checkpointing or creating their WAL/SHM files. After
preflight, SQLite metadata and required columns are checked again. Owned journals
use WAL, `synchronous=FULL` and a 5000 ms busy timeout.

This is an ownership/version guard, not SQLite integrity checking or a hostile
filesystem/file-replacement security boundary. Keep the journal directory trusted
and backed up. A competing initializer may see a reserved incomplete file and
must retry after initialization; it cannot silently claim a foreign database.
Future versions need explicit migration design; version 1 fails closed.

## Effects and reconciliation

SQLite uniqueness and token compare-and-set updates work across independent
connections. External callbacks start only after durable pending insertion. No
transaction spans an await. Completed results replay without remote invocation.
Any callback or completion/serialization failure leaves pending state and throws
`AgentEffectUncertainError` with the stable idempotency key; original callback
errors remain in `cause`.

Reconciliation is checked at runtime before replacing the pending token. It must
be a plain object with exactly `{ status: 'not_applied' }`, `{ status: 'unknown' }`
or `{ status: 'completed', result }`. Completed requires its own explicit result
property; an explicit undefined result is supported. Missing/null/malformed
outcomes, extra keys, accessors and lookup rejection retain the prior pending
state and throw stable keyed AgentEffectUncertainError with the original cause.
Only an exact not_applied outcome authorizes another invocation.

Reconciliation returns completed with a proven result, not_applied only when the
original invocation has stopped and non-application is proven, or unknown. A
claimant must win a token compare-and-set before retrying. A missing lookup record
during an in-flight request is insufficient proof. Completed reconciliation
persists the result without another invocation. The external ledger/provider
must enforce idempotency itself; no general remote exactly-once guarantee exists.

Results must be plain JSON-compatible values (or top-level undefined for void
operations). NaN/infinities, cycles, class instances, accessors, symbol/non-JSON
properties and sparse/extended arrays are refused to avoid changing results on
replay. Results share the `maxEventBytes` cap. They are durable business state:
callers must keep them small and exclude secrets. A failed agent step is not
automatically compensated by the engine. Recover/reconcile its journal effects
explicitly; this optional helper does not change rollback semantics.

Arrays must have Array.prototype and exactly their own length plus every canonical
index from zero through length minus one. Named properties cannot fill holes, and
subclass/prototype serialization overrides are rejected. Validation walks actual
own keys rather than iterating a potentially enormous sparse length.

## Retention and provider boundaries

Defaults: maxEventsPerRun=1000 (range 1–100000) and maxEventBytes=16384 (range
1–1048576). Replay defaults to 100 records, caps at 1000, and accepts a nonnegative
safe-integer after cursor. Global cursor holes from other runs never imply data
loss. Actual per-run evictions update droppedThrough; a reader before it receives
explicit gap metadata. Marker/page reads share a transaction. Event insertion,
optional session checkpoint and eviction share a synchronous immediate transaction.

Progress uses a field allowlist. Raw prompts/messages, tool arguments/results and
successful output are excluded. Caller progress strings still need redaction.
Bounded events do not bound the number of runs, session/effect rows or total
database history. Version 1 has no automatic effect/session cleanup API.

Claude wrappers pass options.abortController, close the query and explicitly wire
stored IDs into resume. IDs cannot recreate provider-local transcripts or a lost
working directory: persist those artifacts at the resumed harness location.
OpenAI examples forward ctx.signal, reject approval interruptions and parse final
output. Streaming callers must await stream.completed. OpenAI/Mastra tools and
effect arrays are constructed per handler for concurrent run isolation. Use a
stable business identity rather than newly generated provider tool-call IDs.

OpenAI business tools disable the SDK's default tool-error-to-text conversion
with errorFunction:null. Both OpenAI and Mastra examples also preserve the first
effect error locally and rethrow it after harness error handling, retaining the
original uncertainty key/cause. An SDK's final text cannot turn a pending remote
operation into a successful workflow step. Supplementary OpenAI history/approval
examples forward ctx.signal and reject interruptions before reading finalOutput.

## Verification

`test/agent-journal.test.ts` exercises real SQLite reopen, run isolation,
foreign/versioned WAL refusal, claims/reconciliation races and retention.
`test/agent-turn.test.ts` covers checkpoint order, outcomes, blocked-read abort and
parsing. Guide/live wrapper regressions execute actual documentation; OpenAI and
Mastra use installed SDKs with offline model fixtures. No credentials, paid
provider calls or external SDK edits are needed.

The public [bunqueue skill](../../skills/bunqueue/SKILL.md) now routes to dedicated
workflow and agent references containing lifecycle, approval, provider resume,
typed terminal failures, strict reconciliation and retention-gap contracts.
The [MCP task evaluation](./mcp-evaluation.md) checks real tool/backends without
an LLM. Its deterministic score is functional evidence and cannot establish
provider or LLM task performance. The optional TaskDriver interface requires
separately supplied provider wiring/usage; none is enabled by default.

Provider examples leave model selection with the user's CLI configuration.
The Claude live script and guide omit the query model option; they no longer
apply an AGENT_MODEL/default override. OpenAI/Mastra examples receive an explicit
caller-configured model and their offline tests inject scripted models. Helper
and evaluation modules choose no provider/model. Historical live output remains
historical; no paid rerun is implied.
