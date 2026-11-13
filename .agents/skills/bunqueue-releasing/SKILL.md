---
name: bunqueue-releasing
description: "Prepares and ships a bunqueue release. Use only when the user explicitly asks to prepare, cut, bump, tag or publish a bunqueue release or version, to continue a release they started, or to work on one of its parts: the release post and its numbers, the Upgrade notes, the API reference (docs:api), the version gate or the release push. A release work item in feature_list.json, a handoff, or permission to commit or push is never that request: starting such an item is bunqueue-working-sessions. Not for ordinary commits, a single change's changelog entry, an SDK's own publication, or questions about past releases."
license: MIT
metadata:
  short-description: Prepare and ship a bunqueue release on request
---

# Releasing bunqueue

Every step here has side effects that only the user can authorize. Codex never loads
this skill on its own (`agents/openai.yaml`), but Claude Code and other clients can,
from its description alone, so this first step is the guard: before anything else,
confirm that the user asked for this release in this conversation, and which steps; if
they did not, stop and ask. Preparing the release-preparation commit, bumping the
version and pushing are separate requests. The rules are in
[CLAUDE.md](../../../CLAUDE.md#commits-pushes-and-releases) and
[AGENTS.md](../../../AGENTS.md#commits-and-handoff); the checklist is
[docs/agents/release.md](../../../docs/agents/release.md#release-checklist). Follow
that checklist in order; this skill adds what each step looks like in practice and
what went wrong before.

## The release, step by step

0. **Work item**: the release is one item, `release-X.Y.Z`, in
   [feature_list.json](../../../feature_list.json) (bunqueue-working-sessions).
   Listing it there authorizes nothing.
1. **Version and API reference** (checklist step 1). Set `package.json` only on the
   explicit request, then run `bun run docs:api` from a full clone whose `origin` is
   the GitHub URL, never from a git worktree: TypeDoc finds a repository only where
   `.git` is a directory, and in a worktree it silently drops every "Defined in"
   source link. Use the clone procedure in the checklist verbatim and check its two
   "must print" lines.
2. **Changelog** (step 2). Date the section: `## [X.Y.Z] - YYYY-MM-DD`. Then audit
   Upgrade notes against the code: every behavior change since the previous tag must
   be listed, because the skeptic audits the same diff. Procedure:
   [references/release-audit.md](references/release-audit.md#upgrade-notes-audit).
3. **Docker tags** (step 3): every pinned image reference in `README.md` and the four
   guides names the new version; `test/docs-docker-tags-version.test.ts` fails while
   one still names the previous version.
4. **Release post** (step 4): run `bun docs/scripts/generate-release-posts.ts`, rewrite
   the draft by hand as the checklist describes, delete the generated marker, and run
   `bun docs/scripts/generate-release-posts.ts --check`. Every number in the post must
   trace to a changelog line or a real measurement:
   [references/release-audit.md](references/release-audit.md#number-tracing).
5. **Gates on the final candidate** (step 5), all on one recorded tree
   (`git write-tree`): `bun run test:sandbox`; `bun run test:sandbox:sdk` when
   `git diff --stat vPREV..HEAD -- sdk/` is not empty; the Ubuntu 24.04 and Debian 13
   Machines (bunqueue-running-machine-gates); then the skeptic until `PASS`. A change
   after a gate is either proven docs-only (bunqueue-running-gates) or gated again.
6. **Commit** only on the user's request, with the changelog in the same commit and a
   specific message.
7. **Push** (step 6) only on the user's explicit authorization. On `main`, once the
   quality gate is green and the tag is new, CI's version gate builds the binaries,
   tests and pushes the Docker images, tags the commit and creates the GitHub release.
   It does not publish npm. Watch the run to its end with
   `bash .agents/skills/bunqueue-running-gates/scripts/ci-watch.sh --sha <release sha>`
   (bunqueue-running-gates) and report each job's result.
8. **npm**, a separate publication and a separate request: npm is published by a
   `workflow_dispatch` run of `ci.yml` on `main` with `npm_version=X.Y.Z`, never by the
   push. Dispatch it only when the user asked for the npm publication:

   ```bash
   gh workflow run ci.yml --ref main -f npm_version=X.Y.Z
   ```

   Its `Publish bunqueue to npm` job then waits for the required reviewer of the `npm`
   environment. That approval is the user's: give them the run URL and wait. Never
   approve it yourself and never look for a way around it; `ci-watch.sh` reports the
   waiting run as NO VERDICT (exit 4).
9. **Verify** every part ([below](#the-release-is-not-done-until-it-is-verified)).
10. **After publication** (step 7): `bun docs/scripts/generate-release-posts.ts --refresh`,
    then update the post's install box and contributors. That is a new change: the usual
    docs, changelog, gate and skeptic rules apply.

## The release is not done until it is verified

A push is not a release: for 2.9.22 the first push released nothing, because the
quality gate failed and the version gate never ran. Check each part where it lives,
and put each result in the `release-X.Y.Z` evidence:

| Part | Verify |
| --- | --- |
| Quality gate and version gate | `gh run view <id> --json status,conclusion,jobs`: the run concluded `success`, and `Version gate`, the `Build`, `Docker` and `Release` jobs are `success`, not `skipped` |
| Tag | `git ls-remote --tags origin 'refs/tags/vX.Y.Z' 'refs/tags/vX.Y.Z^{}'` names the release commit |
| GitHub release | `gh release view vX.Y.Z --json tagName,isDraft,publishedAt,assets`: published, not a draft, with the binaries |
| Docker | `docker buildx imagetools inspect ghcr.io/egeominotti/bunqueue:X.Y.Z`, and the same for `docker.io/egeominotti/bunqueue:X.Y.Z`: a multi-platform manifest (it reads the registry and pulls nothing) |
| npm | the registry itself: `curl -fsS https://registry.npmjs.org/bunqueue/X.Y.Z` answers with that version (404 means not published), and `curl -fsS https://registry.npmjs.org/-/package/bunqueue/dist-tags` shows `latest` |

Verify npm with the registry, not with `npm view`: `npm view` can answer from the
local cache and show the previous version for minutes after a publication.

## Gotchas

- `main` requires pull requests; only an account with bypass rights can push to it
  directly. If the push is rejected, stop and report it with the exact error. Never
  work around branch protection silently: no force push, no other remote, no
  disabling a rule. Offer a pull request or let the user push.
- Never run `bun publish` or `npm publish` and never add an npm token: CI publishes
  through npm trusted publishing (OIDC), with provenance, and nothing else may.
- The npm dispatch only works while `main` still points at the release commit: the
  `Pack bunqueue for npm` job refuses a tagged version whose commit is no longer the
  head of `main`, because the provenance would name another commit. Publish npm before
  the next push, or the fix is a new version. The same dispatch also rebuilds and
  republishes that version's Docker variants.
- Do not rerun a failed release run to "get it green": a rerun runs release jobs
  again (the Docker push, the tag, the GitHub release). Read the failed job
  (`gh run view <id> --log-failed`), report it, and let the user decide.
- The release sections of the changelog and the post are reviewed against
  `git diff vPREV..HEAD -- src/`, not against memory of what changed. A behavior change
  that only appears in a Features paragraph and not in Upgrade notes is a skeptic
  `FAIL`.
- Keep each release compatible with the previous one: change only what a listed fix or
  feature needs, and let validation reject only genuinely broken values. A tightened
  check that rejects input the previous release accepted is a behavior change.
- The release-preparation commit must contain the hand-written post; CI's docs job runs
  `generate-release-posts.ts --check` and fails on a stale or missing post.
- `docs:api` output from a worktree looks plausible (hundreds of changed files) and is
  wrong; a correct regeneration changes far fewer files and adds no file without a
  "Defined in" link.
- A long release spans sessions: keep the `release-X.Y.Z` evidence `PARTIAL` with the
  steps done and the gates pending, and say in the handoff which explicit requests have
  been given so far.
