# Evidence for the Definition of Done

`evidence` in `feature_list.json` is the proof the next session and the skeptic rely
on. Write facts that someone can rerun or open: commands, exact totals, artifact paths,
tree hashes, commits. Impressions ("all green", "should be fine") are not evidence.

## Definition of Done, item by item

| Definition of Done | What the evidence names |
| --- | --- |
| Behavior implemented; a bug has a test that failed before and passes after | the test path, its failure line before the fix, its pass totals after |
| Required gates ran and passed | `bun run test:sandbox` totals per suite and its artifact directory; `bun run test:model` and `bun run test:sandbox:sdk` totals, or why they were not triggered; `bun run typecheck` and `bun run format:check` results |
| `/docs` and the changelog describe the change | the docs files and the changelog section updated |
| Skeptic `PASS` | each verdict in order (`FAIL`, then fixes, then `PASS`) |
| `./init.sh` green | that it ran green on the final tree |
| After a push, CI green | the run id, attempt and URL, the `ci-watch.sh` exit code, and the work item of any flake |

The contract test rejects a `done` item whose evidence names no command, or neither an
artifact path (`artifacts/<gate>/<run>/`) nor a commit or tree hash. That is a floor,
not the standard: the table above is.

## A finished item

```text
2026-11-12, base da289219; lands in the commit that adds this entry.
bun run test:sandbox green on the exact staged tree <hash>: unit 11668 pass / 0 fail /
398 skip, tcp 553 / 0, embedded 349 / 0, no resource anomalies
(artifacts/test-sandbox/2026-11-12T20-20-16.500Z/summary.md). Host: bun test
test/agent-harness 22 / 0, ./init.sh green, bun run typecheck and bun run format:check
clean, git diff --check clean. bun run test:model and bun run test:sandbox:sdk not
triggered (no src/ or sdk/ change). Skeptic: FAIL, then fixes, then PASS on the final
delta.
```

## An item still in progress

```text
PARTIAL, gates pending. 2026-11-12, base 18bfc76f, uncommitted. Steps 1-4 done: <what>.
Host checks (diagnostic): <command totals>. Not run: bun run test:sandbox, the
OrbStack Machines, skeptic.
```

## Common gaps the skeptic flags

- Totals without the artifact path, or an artifact path for a different tree than the
  one committed.
- "Gate passed" for a gate that ran before the last code change.
- Host-only results presented as the gate.
- A `done` item whose commit is not named, or whose dependencies are not `done`.
