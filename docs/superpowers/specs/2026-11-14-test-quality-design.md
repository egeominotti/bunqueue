# Test quality and duration improvements

The user approved implementing all findings of the test-only audit. Improve the
tests' ability to detect broken behavior, remove proven duplication and replace
unnecessary observation sleeps with bounded observation of real state.

## Scope

- Remove six identical product cases and four legacy method/listener-existence
  cases, retaining the real behavioral tests that cover their claims.
- Strengthen manual lock extension, rate/concurrency enforcement and removal,
  and DLQ pagination/fixture completion. Empty fixtures cannot silently pass.
- Replace workflow observation sleeps in both modes with bounded state/event
  waits. Preserve all 19 scenarios, results, ordering, retries and real timeouts.
- Correct the capped DLQ helper, separate fast automatic retry from manual TTL
  purge, and run stall/heartbeat scenarios through fast real broker sweeps.
- Close owned resources in finally and expose teardown errors.
- Keep edited test files/utilities at most 300 lines by splitting by concern.

## Constraints

No changes to src/, SDKs, dependencies, package versions, CI or gate runners.
Use existing timer configuration only in test-owned brokers. Keep real
Queue/Worker/Engine/TCP/SQLite paths. Keep model campaigns, persistence/crash
regressions, and real maximum/default long-poll/outage contracts.

Retain exact manual expiry/purge coverage: globally accelerating DLQ maintenance
would race its maxAge=100 case. Separate its broker lifetime from auto-retry.
Keep a stuck worker alive until stall recovery is observed. Shorten the heartbeat
processor only together with faster real sweeps and prove missing heartbeats are
detected. Subscription/event waits require explicit readiness, not just completion.

## Evidence

Baseline main is 699b18a0. Last sandbox: unit11916/0/403 (6.89min), TCP553/0
(8.91min), embedded349/0 (4.13min). Workflow files: TCP104.102s/embedded74.567s;
advanced DLQ60.082s/60.189s; stall27.976s/28.808s. These are existing observations,
not promised gains. Compare equivalent isolated commands and full gate reports.

For improved assertions, characterize realistic mutants on disposable copies:
the weak case passes and the strengthened case fails for the intended reason;
then restore the real implementation and pass. Never change production files in
the worktree. For deletions/splits, map every removed case to surviving coverage
and preserve all other case bodies/fixtures and both modes.

Final validation uses the full product sandbox and fresh native Ubuntu Machine,
typecheck/format, documentation readers and independent review. Record complete
logs, exact totals, resource anomalies and measured durations. The existing
authorized commit/push/merge workflow uses egeominotti and normal protected PRs;
no version bump, release or publication.
