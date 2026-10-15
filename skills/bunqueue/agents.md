# Optional agent turns, sessions and effects

`bunqueue/agents` exports `AgentJournal`, `consumeAgentTurn`, `mapClaudeMessages`,
`runAgentEffect`, `agentEffectKey`, `AgentTurnError`, `AgentEffectUncertainError`
and their types. It is Bun-only, imports no provider SDK and starts no worker.
Read [workflow.md](workflow.md) for register/recover/start/signal/close.

## Actual turn boundary

`consumeAgentTurn(source, { signal?, schema?, journal?, executionId?, stepId?,
cancel? })` consumes normalized async events and returns `{ sessionId, output }`
only on terminal success. `schema` is a structural `{ parse(value): T }` object
(for example Zod). Exhaustion/transport failure is not success. A journal requires
both identity fields; session checkpoints commit before the next provider read.

Workflow `StepContext` exposes `executionId` and an optional `signal`, but has no
`stepId` property. Supply your own stable step name explicitly to the journal and
effect helper (and distinguish loop iterations/business operations when needed).

For Claude, wrap the provider `query()` source in `mapClaudeMessages(queryResult)`.
Read `journal.getSession(ctx.executionId, 'draft')` before querying and
explicitly set `options.resume` when present. Pass a provider AbortController in
`options.abortController`, forward `ctx.signal` through `consumeAgentTurn`, and
supply `cancel` to abort and close the provider query. The adapter recognizes
init/result sessions and terminal success/failure, excluding raw messages. It
does not invoke the provider or automatically wire resume options.

OpenAI/Mastra wrappers parse final output or normalize their events. Forward
`ctx.signal`, reject approval interruptions, and await OpenAI streaming
`stream.completed` before reading final output. Construct tools/effect arrays
per handler invocation. OpenAI business tools set `errorFunction: null` to disable
tool-error-to-text conversion. Preserve/rethrow the first effect error locally
even when the SDK turns it into text. Actual supported wrappers are in the
[provider guide](https://bunqueue.dev/guide/workflow/agent-sdks/).

`AgentTurnError.code`: `interrupted`, `failure`, `cancelled`, `needs_input`,
`invalid_output`. Secondary failure-event write errors appear in `recordingError`;
the original code/cause survives. Success still requires durable recording.
Needs-input requires explicit application approval/state handling. Cancellation
is cooperative; a provider ignoring abort may continue remote work.

Concrete Claude handler wiring (provider credentials/model/permissions remain
application configuration; this example does not authorize provider execution):

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Workflow } from 'bunqueue/workflow';
import { AgentJournal, consumeAgentTurn, mapClaudeMessages } from 'bunqueue/agents';

const journal = new AgentJournal('./data/agent-turns.db');
const flow = new Workflow<{ prompt: string }>('draft-plan')
  .step('draft', async (ctx) => {
    const resume = journal.getSession(ctx.executionId, 'draft');
    const abortController = new AbortController();
    if (ctx.signal?.aborted) abortController.abort();
    const q = query({ prompt: ctx.input.prompt, options: {
      cwd: '/persistent/application/workspace', abortController,
      ...(resume ? { resume } : {}),
    } });
    try {
      return await consumeAgentTurn(mapClaudeMessages(q), {
        journal, executionId: ctx.executionId, stepId: 'draft',
        signal: ctx.signal,
        schema: { parse(value: unknown) {
          if (typeof value !== 'string') throw new Error('Expected text output');
          return value;
        } },
        cancel: () => { abortController.abort(); q.close(); },
      });
    } finally { q.close(); }
  });
// Register/recover/start with the Engine lifecycle in workflow.md.
// Await engine.close(), then journal.close(), when all handlers stop.
```

For OpenAI import `{ Agent, run, tool }` from `@openai/agents`. Execute
`const result = await run(agent, prompt, { signal: ctx.signal })`; if
`result.interruptions.length` is nonzero, throw before reading finalOutput.
Use a parse schema on `result.finalOutput`. Persist the SDK's history/session
artifacts explicitly if continuing a turn; bunqueue does not map OpenAI sessions
automatically. Bind every business `tool` to the effect helper below.

## Storage and resume

Create `new AgentJournal('./data/agent-turns.db', { maxEventsPerRun: 1000,
maxEventBytes: 16384 })` in a trusted directory. Use a dedicated file, separate
from queue/workflow databases. Memory/foreign/unsupported files are refused.
Close after all handlers stop; repeated close is safe.

`checkpointSession(executionId, stepId, sessionId)` explicitly stores a session;
`getSession` returns its ID or null. IDs cannot recreate provider-local
transcripts, working directories or files. Preserve these artifacts at the
resumed harness location, plus journal and workflow execution storage.

## Stable business effects

```typescript
import { runAgentEffect } from 'bunqueue/agents';

// Inside a handler; journal and billing are application-owned.
const receipt = await runAgentEffect({
  journal,
  executionId: ctx.executionId,
  stepId: 'charge-order',
  callId: `charge:${ctx.input.orderId}`,
  invoke: (idempotencyKey) => billing.charge(ctx.input.orderId, { idempotencyKey }),
  reconcile: (idempotencyKey) => billing.reconcile(idempotencyKey),
});
```

`callId` identifies the same business action/parameters across retries and
sessions, rather than a newly generated provider tool-call ID.
`agentEffectKey({ executionId, stepId }, callId)` gives the stable remote key.
Pending state commits before invocation. Completed results replay without another
call. Callback/serialization/commit failures leave pending state and throw
`AgentEffectUncertainError` with `idempotencyKey` and original `cause`.

Reconcile by that key with exactly one plain-object shape:

| Return | Proof and behavior |
| --- | --- |
| `{ status: 'completed', result }` | Proven applied result, persisted without another invocation. Explicit `result: undefined` is valid for void work. |
| `{ status: 'not_applied' }` | Original invocation stopped and non-application is proven; only this shape permits retry. |
| `{ status: 'unknown' }` | Still uncertain; no repeat. |

Missing lookup rows during an in-flight request are insufficient proof. Null,
malformed shapes, extra keys/accessors and lookup rejection retain pending state
and throw keyed uncertainty. Providers/ledgers must enforce idempotency; there is
no general remote exactly-once guarantee. Results must be small plain JSON values
(or top-level undefined) without secrets. Effects from a failed agent step need
application reconciliation/compensation; engine rollback semantics are unchanged.

## Bounded progress replay

`journal.append(executionId, stepId, event)` stores normalized events and returns
a monotonic global cursor. Events: `session`, `progress`, `tool`, `usage`,
`success`, `failure`, `cancelled`, `needs_input`. Tool lifecycle uses
`{ type: 'tool', name, callId?, status: 'started' | 'completed' | 'failed' }`.
Stored progress excludes
raw prompts/messages, tool arguments/results and successful output. Redact caller
progress strings; stored effect results remain separate business data.

`journal.replay(executionId, { after: cursor, limit: 100 })` returns
`{ events, nextCursor, gap }`. Continue from nextCursor until the page is empty.
Limit defaults to 100, caps at 1000; after is a nonnegative safe integer.
`gap: { droppedThrough }` means actual eviction in this run: display the gap and
refresh durable state. Global cursor holes from other runs are not loss. Page
and marker share a consistent snapshot.

Defaults: 1000 events/run (range 1–100000), 16384 bytes/event (1–1048576). This
does not bound run count, session/effect rows or total history; v1 has no automatic
session/effect cleanup. Application/operator retention and backup are required.
Live workflow events and MCP sessions do not replace this replay API.

## Complete OpenAI tool/turn wiring

This pattern receives the model from CLI/user configuration. `billing` is the
application provider/ledger; its reconciliation must satisfy the proof rules
above. The tool and effect collection are created inside each run's handler.

```typescript
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';
import { Workflow } from 'bunqueue/workflow';
import { AgentJournal, AgentTurnError, runAgentEffect,
  type EffectReconciliation } from 'bunqueue/agents';

declare const configuredModel: string; // Required caller/CLI input; no default.
declare const billing: {
  charge(orderId: string, amount: number, key: string): Promise<{ receiptId: string }>;
  reconcile(key: string): Promise<EffectReconciliation<{ receiptId: string }>>;
};
const journal = new AgentJournal('./data/openai-turns.db');
const flow = new Workflow<{ orderId: string; amount: number }>('approved-charge')
  .waitFor('operator-approval')
  .step('agent-charge', async (ctx) => {
    const approval = z.object({ approved: z.literal(true) });
    approval.parse(ctx.signals['operator-approval']);
    const effects: Array<{ receiptId: string }> = [];
    let effectError: unknown;
    const charge = tool({
      name: 'charge_order', description: 'Charge this approved order once',
      parameters: z.object({ orderId: z.string(), amount: z.number() }),
      errorFunction: null,
      execute: async ({ orderId, amount }) => {
        if (orderId !== ctx.input.orderId || amount !== ctx.input.amount) {
          throw new Error('Arguments do not match the approved business operation');
        }
        const receipt = await runAgentEffect({
          journal, executionId: ctx.executionId, stepId: 'agent-charge',
          callId: `charge:${orderId}:${amount}`,
          invoke: (key) => billing.charge(orderId, amount, key),
          reconcile: (key) => billing.reconcile(key),
        }).catch((error) => { effectError ??= error; throw error; });
        if (!effects.some((item) => item.receiptId === receipt.receiptId)) {
          effects.push(receipt);
        }
        return JSON.stringify(receipt);
      },
    });
    const agent = new Agent({ name: 'approved-charge', model: configuredModel,
      tools: [charge] });
    const result = await run(agent, `Charge ${ctx.input.orderId} ${ctx.input.amount}`,
      { signal: ctx.signal }).catch((error) => { throw effectError ?? error; });
    if (effectError) throw effectError;
    if (ctx.signal?.aborted) throw new AgentTurnError('cancelled');
    if (result.interruptions.length) throw new AgentTurnError('needs_input');
    if (effects.length !== 1) throw new Error('Expected one approved charge effect');
    try {
      return { text: z.string().parse(result.finalOutput), effects };
    } catch (cause) { throw new AgentTurnError('invalid_output', { cause }); }
  }, { retry: 1 });
// Register/recover/start/signal with workflow.md; close Engine before journal.
```

Final text does not prove a charge occurred: independently inspect the provider
ledger/effects for the expected business outcome. If the task requires charging,
reject a zero-effect turn instead of accepting fluent final text. This example
declares no automatic inverse; implement approved compensation/reconciliation
according to your business contract. No model/provider is invoked by this skill.

## Exact normalized events and cancellation boundary

The public `AgentEvent` union is:

```typescript
type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'progress'; message?: string }
  | { type: 'tool'; name: string; callId?: string;
      status: 'started' | 'completed' | 'failed' }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'success'; output: unknown }
  | { type: 'failure' | 'cancelled' | 'needs_input'; code?: string };
```

There is no public per-execution `engine.cancel()` API. Existing step timeout
and force-close (`await engine.close(true)`) signal active handlers cooperatively;
force-close affects the Engine, not one chosen execution. For turn-specific
application cancellation, own an AbortController and combine its signal with
`ctx.signal` when present (for example `ctx.signal ?
AbortSignal.any([ctx.signal, turnController.signal]) : turnController.signal`),
then forward that signal and a provider cancellation callback. `consumeAgentTurn`
throws typed cancellation; this does not create a workflow "cancelled" state or
prove remote operations stopped. Inspect durable workflow/effect state after
shutdown/recovery and reconcile uncertain remote work.
