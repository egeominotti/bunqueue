# Durable workflows

Use `Workflow` and `Engine` from `bunqueue/workflow` for durable orchestration in
Bun. This API is experimental; external language SDKs do not run step code.
`FlowProducer` handles queue dependencies, rather than this lifecycle.

## Definition, recovery and approval

```typescript
import { Engine, Workflow } from 'bunqueue/workflow';

const flow = new Workflow<{ orderId: string }>('review-order')
  .step('prepare', async (ctx) => ({ orderId: ctx.input.orderId }))
  .waitFor('operator-approval', { timeout: 86400000 })
  .step('approved-plan', async (ctx) => {
    const decision = ctx.signals['operator-approval'];
    if (!decision || typeof decision !== 'object' ||
        !('approved' in decision) || decision.approved !== true) {
      throw new Error('Operator did not approve');
    }
    return { approved: true, orderId: ctx.steps.prepare.orderId };
  }, { retry: 1 });

const engine = new Engine({ embedded: true, dataPath: './data/workflows.db' });
engine.register(flow);
await engine.recover(); // register all definitions first, on every restart
const run = await engine.start('review-order', { orderId: 'order-123' });
const execution = engine.getExecution(run.id);
// An authorized operator later supplies the decision:
// await engine.signal(run.id, 'operator-approval', { approved: true });
// Stop accepting new work, then await engine.close() before exiting.
```

`start` returns while the run continues. Inspect `getExecution(run.id).state`
until `completed` or `failed`, with an application deadline. `waiting` is a parked
gate, not success. Live subscriptions are not durable replay; attach listeners
before starting when early events matter. `listExecutions(name?, state?,
{ limit, offset })` defaults to 100, with creation-time/ID order; concurrent
insertion can shift offsets, so pages do not form a snapshot.

Persist the same workflow database and register compatible definitions before
`recover()`. Completed records short-circuit; an interrupted unknown operation
may replay. `dataPath` is the execution store. In TCP mode use
`new Engine({ embedded: false, connection: { host, port }, dataPath })` with a
separate local execution file and a persistent broker.

Validate gate payloads before sensitive actions. Signals are first-wins by event
name and can be recorded before the gate; use distinct event names for different
approval stages. Omitting a gate timeout waits indefinitely; `timeout: 0` fails
immediately. An agent's `needs_input` does not automatically create a gate.

## Effects and compensation

Providers must honor stable idempotency keys. A normal step uses
`ctx.idempotencyKey`; compensation has its own key and can reconcile the forward
operation through `ctx.forwardIdempotencyKey`. Declare a `compensate` handler
when a completed effect has an inverse. Inspect both `failureReason` and
`rollbackStatus` to distinguish failed work from failed undo.

Agent steps may issue several tools before returning. Wire the optional
[agent journal/effect helper](agents.md) into each business tool. The engine does
not automatically compensate effects from a failed agent step: explicitly
reconcile pending effects before deciding what to retry or undo. Missing local
output is not proof of remote non-application.

Read [mcp.md](mcp.md) for approval tooling. MCP list/inspect reads an existing
workflow store. Signal delivery requires Engine and MCP to use the same TCP
broker/step queue and same-host write access to the Engine's separate execution
file. An embedded Engine must be signalled in its application via `engine.signal`.

Full guides: [quickstart](https://bunqueue.dev/guide/workflow/quickstart/),
[approval](https://bunqueue.dev/guide/workflow/approval/),
[durability](https://bunqueue.dev/guide/workflow/durability/),
[rollback](https://bunqueue.dev/guide/workflow/rollback/),
[API](https://bunqueue.dev/guide/workflow/api/).
