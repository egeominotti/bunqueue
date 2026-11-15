# Performance optimizations with unchanged tests

The user authorized implementing the three measured optimizations and checking
stability, explicitly requiring that no existing test be altered. The user later
authorized commit, push and merge to main, plus an engineering article/report.
Version bumps and package publication remain unauthorized.

## SQLite safety decision

The differential fault assessment found that transaction grouping cannot preserve
the scalar durable successful prefix after automatic rollback followed by
permanent storage failure. The original prototype also publishes RAM-only jobs
after unconfirmed rollback and can leave a closed connection's transaction live.
Native rollback, wrapper failures and nested serialization were examined
separately. The SQLite runtime will remain unchanged in this change-set; its
speedup is experimental and is not claimed for the delivered implementation.
Changing the durable admission contract or adding an independent durable log
requires separate design and authorization. Monitoring and MessagePack proceed.

## Scope

- Retain the scalar SQLite durable-admission path after safety assessment found
  transaction grouping could not preserve its durable-prefix failure contract.
- Aggregate active counts once per monitoring pass while retaining time
  boundaries, disabled checks and synchronous dashboard callback observations.
- Replace the MessagePack JavaScript byte scan with a bounded native search
  while retaining lossless own prototype keys and safe decoding.
- Retain public APIs, protocol, schema, durability configuration, ordering and
  scheduling semantics.

## Constraints and evidence

All existing tests, fixtures and test support files stay byte-identical. No test
is added, removed, skipped, weakened or excluded. Existing tests run unchanged;
new differential fault drivers may live only under ignored artifacts. This
explicit constraint overrides defaults requiring new failing unit tests.
Product code must not acquire test hooks.

SQLite must handle statement/serialization failure, BEGIN/COMMIT/ROLLBACK
failure, automatic rollback, disk-full conditions, closed connections and crash
boundaries without RAM-only admissions or duplicate accounting. Fall back before
changing observable state when eligibility or safe recovery cannot be established.
Prefer narrower eligibility to a behavior change. Accessors, proxies and
serialization side effects require explicit differential checks.

Source files remain at most 300 lines. Every source change updates its internal
feature documentation and changelog. No dependency or environment default changes.

Run typecheck, formatting, unchanged-test hashes, targeted diagnostics, the model
campaign, full product and SDK sandboxes, and a fresh native Ubuntu 24.04 Machine.
Run benchmarks on native macOS separately from functional gates. Review all
failures and anomalies. Original prototype evidence is in the original checkout
under artifacts/performance-ab-2026-11-15/ and is not final stability evidence.
