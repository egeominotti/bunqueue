# bunqueue Governance

This document describes how the bunqueue project is run: who makes decisions, how
they are made, and how the project stays sustainable. It covers this repository and
everything published from it (the `bunqueue` npm package, release binaries, container
images and the official SDKs under `sdk/`).

## Principles

- **Open by default.** Design discussions, roadmaps and decisions happen in public
  GitHub issues, discussions and pull requests. Only security reports and Code of
  Conduct cases are handled privately.
- **Correctness before features.** No job may be lost, duplicated or resurrected. Changes
  that weaken a documented guarantee are not accepted, whatever their benefit.
- **Stable contracts.** Users can upgrade within a major version without code changes
  (see [VERSIONING.md](VERSIONING.md)).
- **MIT, permanently.** The code in this repository stays under the MIT License.
  Commercial offerings built around bunqueue never move existing features out of it.

## Roles

| Role            | Who                                                       | Responsibilities and rights                                                                                    |
| --------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **User**        | Anyone using bunqueue                                     | Report bugs, request features, take part in discussions.                                                       |
| **Contributor** | Anyone who has had a contribution merged                  | Everything a user does; propose changes following [CONTRIBUTING.md](CONTRIBUTING.md).                          |
| **Maintainer**  | Listed in [MAINTAINERS.md](MAINTAINERS.md)                | Review and merge pull requests in their area, triage issues, take part in security response.                  |
| **Lead maintainer** | Listed in [MAINTAINERS.md](MAINTAINERS.md)            | Final decision when consensus fails, releases and publishing, security response lead, maintainer appointments. |

Code ownership for review routing is defined in [`.github/CODEOWNERS`](.github/CODEOWNERS).

### Becoming a maintainer

A contributor with a sustained record of high-quality contributions and reviews over
at least three months can be nominated by any maintainer. The nomination is a public
issue; it is accepted when no maintainer objects within 7 days and the lead
maintainer approves. New maintainers start with a scoped area (for example one SDK).

### Stepping down and inactivity

Maintainers can step down at any time and become emeritus. A maintainer inactive for
six months is asked whether they want to continue; with no answer within 30 days
they move to emeritus. Emeritus maintainers can return by the same nomination process.

## Decision making

1. **Lazy consensus** for routine changes: a pull request approved by a code owner
   with green CI can be merged.
2. **Request for Comments (RFC)** for significant changes, required for:
   - TCP protocol or HTTP API changes;
   - changes to the persisted data model (SQLite or PostgreSQL schema);
   - new public API surface or new official SDKs;
   - deprecations and anything breaking per [VERSIONING.md](VERSIONING.md);
   - changes to delivery, ordering or durability guarantees.

   An RFC is a GitHub issue labeled `rfc` that states motivation, design,
   alternatives, compatibility and migration impact, and a test plan. It stays open
   for comment for at least 7 days (14 for breaking changes) before a decision.
3. **Escalation**: when consensus is not reached, the lead maintainer decides and
   records the reasoning in the issue.

Decisions on security reports follow [SECURITY.md](SECURITY.md); Code of Conduct
cases follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Releases

- Releases follow [Semantic Versioning](https://semver.org/) and the support windows in
  [VERSIONING.md](VERSIONING.md).
- Only the lead maintainer (or a maintainer explicitly delegated for a release) bumps
  versions and publishes artifacts.
- A release ships only when every required gate in [CONTRIBUTING.md](CONTRIBUTING.md)
  and CI is green, and `docs/src/content/docs/changelog.md` documents it.
- Every release is tagged `vX.Y.Z` on `main` and has GitHub release notes.

## Continuity

To keep the project usable if a maintainer becomes unavailable:

- The goal is for publishing rights for npm, the container registries and the domain
  `bunqueue.dev` to be held by at least two people or by an organization account with
  recovery configured. Until a second maintainer joins, they are held by the lead
  maintainer with account recovery configured.
- Release procedures are scripted in CI and documented in the repository, not in
  personal notes.
- If the project is ever discontinued, the intent is to announce it with at least six
  months of security-fix support for the last minor release and to archive the
  repository, not delete it.

The commitments in this document are good-faith intentions, not contractual
obligations; see [DISCLAIMER.md](DISCLAIMER.md).

## Changes to this document

Changes to governance follow the RFC process above and require approval from the lead
maintainer.
