## Summary

<!-- What does this change do and why? Link the issue or RFC: "Closes #123". -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (requires an approved RFC, see GOVERNANCE.md)
- [ ] Documentation only
- [ ] Build, CI or tooling

## Compatibility

<!-- Does this touch the public API, TCP/HTTP protocol, persisted schema, CLI, env vars,
metric names, or delivery/ordering/durability guarantees? Describe the impact and any
migration. See VERSIONING.md. -->

## How was this tested?

- [ ] Added or updated tests (bug fixes include a test that fails without the fix)
- [ ] `bun run test:sandbox` passes (not required for documentation-only changes)
- [ ] `bun run test:model` passes (lifecycle, persistence, recovery or scheduling changes)
- [ ] `bun run test:sandbox:sdk` passes (changes under `sdk/`)

## Checklist

- [ ] Technical docs under `docs/` updated in this change
- [ ] `docs/src/content/docs/changelog.md` updated
- [ ] No secrets, credentials or real job payloads in code, tests or logs
- [ ] Commit messages are specific and in English
