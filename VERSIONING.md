# Versioning, Support and Deprecation Policy

## Semantic Versioning

bunqueue follows [Semantic Versioning 2.0.0](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **PATCH**: bug fixes, security fixes, performance work. No behavior change for
  correct programs.
- **MINOR**: new backwards-compatible features, new configuration with safe defaults,
  deprecations.
- **MAJOR**: removal of deprecated features and other incompatible changes.

## What the compatibility contract covers

Within a major version, these do not change incompatibly:

| Surface                       | Examples                                                                 |
| ----------------------------- | ------------------------------------------------------------------------ |
| Public TypeScript API         | Every entry point in `package.json` `exports` (`bunqueue`, `bunqueue/client`, `bunqueue/workflow`, ...) and the `bunqueue` / `bunqueue-mcp` binaries |
| Wire protocols                | TCP commands and msgpack frames, HTTP/WebSocket/SSE endpoints            |
| Persisted data                | SQLite and PostgreSQL schemas: a newer release of the same major opens data written by an older one |
| Operations surface            | CLI commands and flags, environment variables, config file keys, Prometheus metric names and labels |
| Behavioral guarantees         | Delivery, retry, ordering, durability and DLQ semantics documented in `docs/` |

Not covered: anything under `src/` that is not exported, internal file layout,
benchmark numbers, log message wording, and APIs explicitly marked
`@experimental` or `@internal`.

**Rolling upgrades:** the goal is that a server and clients one minor version apart
interoperate, so servers and workers can be upgraded independently. Until this is
covered by automated cross-version tests, upgrade servers before clients and verify
in a staging environment first.

**Downgrades:** a downgrade to an older minor is not guaranteed once a newer minor
has migrated the data. Take a backup before upgrading.

## Support windows

| Release line                         | Bug fixes | Security fixes                               |
| ------------------------------------ | --------- | -------------------------------------------- |
| Latest minor of the current major    | Yes       | Yes                                          |
| Previous minor of the current major  | No        | Critical and High, for 3 months after the next minor ships |
| Last minor of the previous major     | No        | Critical and High, for 12 months after the next major ships |
| Anything older                       | No        | No                                           |

The official SDKs under `sdk/` follow the same rules against their own versions.

## Runtime support

bunqueue supports the Bun version pinned in CI and later Bun releases within the range
declared in `package.json` `engines`. PostgreSQL persistence supports the versions
tested in CI (currently 15 to 18). Dropping a runtime or database version is
announced at least one minor release in advance and happens only in a minor or
major release, never in a patch.

## Deprecation process

1. Open an RFC (see [GOVERNANCE.md](GOVERNANCE.md#decision-making)).
2. Mark the feature deprecated in a minor release: documentation, a `@deprecated`
   JSDoc tag, a one-time runtime warning, and a changelog entry with the migration path.
3. Keep it working for at least one full minor release and at least 3 months.
4. Remove it only in the next major release, listed under **Breaking changes** in the
   changelog with a migration guide.

A security issue may require an incompatible change outside this process. Such changes
are kept as small as possible and are clearly flagged in the advisory and changelog.

## Release cadence

- Patch releases ship as needed.
- Minor releases ship when features are ready, typically every few weeks.
- Major releases are announced in an RFC at least 3 months in advance.

Every release is listed in the [changelog](https://bunqueue.dev/changelog/).
