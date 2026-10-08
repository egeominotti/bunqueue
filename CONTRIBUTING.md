# Contributing to bunqueue

Thanks for your interest in bunqueue. This guide explains how to propose changes and
what a change needs before it can be merged.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Security problems follow [SECURITY.md](SECURITY.md), never a public issue.

## Before you start

- **Bugs**: open a [bug report](https://github.com/egeominotti/bunqueue/issues/new?template=bug_report.yml)
  with a minimal reproduction.
- **Features or behavior changes**: open a
  [feature request](https://github.com/egeominotti/bunqueue/issues/new?template=feature_request.yml)
  first and wait for agreement on the design. Changes to the TCP protocol, persisted
  data model or public API need that discussion before code.
- Small fixes (typos, docs, obvious one-line bugs) can go straight to a pull request.

## Development setup

Requirements: Bun at the version pinned in CI (`1.4.2`), Git, and Docker or OrbStack
for the isolated test gates.

```bash
git clone https://github.com/egeominotti/bunqueue.git
cd bunqueue
bun install --frozen-lockfile
bun run typecheck
bun run check:oxc
```

The pre-commit hook runs `typecheck` and `check:oxc` (Oxlint + Oxfmt).

## Code guidelines

- TypeScript, strict mode. Follow the layering in `docs/architecture.md`
  (`domain` → `application` → `infrastructure`, `client`, `cli`, `mcp`).
- At most 300 lines per file and one concern per file; export only what is needed.
- All repository content is in English: code, comments, tests and documentation.
- Match the style of the surrounding code; run `bun run lint:fix && bun run format`.

## Tests

Bug fixes start with a test that fails without the fix. Every code change must pass
the full isolated gate (documentation-only changes are exempt):

```bash
bun run test:sandbox
```

It runs the unit suite, the TCP integration suites and the embedded integration
suites in disposable containers. Additional gates:

| Change touches                                                        | Also run                   |
| --------------------------------------------------------------------- | -------------------------- |
| Job lifecycle, persistence, recovery, scheduling, dedup, locks, limits | `bun run test:model`       |
| Anything under `sdk/`                                                  | `bun run test:sandbox:sdk` |
| PostgreSQL persistence                                                 | `bun run test:postgres`    |

Never weaken an invariant or delete a failing test to make a run green. See
`docs/testing.md` for the full rationale.

## Documentation and changelog

A change is complete only when, in the same pull request:

- the internal technical reference under `docs/` (`architecture.md`, `data-model.md`,
  `features/<slug>.md`) reflects it;
- `docs/src/content/docs/changelog.md` describes it for users.

## Pull requests

- One logical change per pull request, with a specific English commit message that
  describes what changed (no placeholders such as "fix" or "update").
- Describe the motivation, the behavior change and how you tested it.
- Call out breaking changes explicitly; they follow the deprecation policy below.
- CI must be green. A maintainer listed in [MAINTAINERS.md](MAINTAINERS.md) reviews every change.

## Versioning and deprecation

bunqueue follows [Semantic Versioning](https://semver.org/). What the compatibility
contract covers, the support windows and the deprecation process are defined in
[VERSIONING.md](VERSIONING.md). Significant changes go through the RFC process in
[GOVERNANCE.md](GOVERNANCE.md#decision-making).

Version bumps and publishing are done by maintainers only.

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
