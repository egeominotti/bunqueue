# Releases, Publishing and Release Posts (agents)

Releases, publishing and release posts. Three sections are moved verbatim from the
root `CLAUDE.md`: [Release actions need explicit authorization](#release-actions-need-explicit-authorization)
(its paragraph, under a new heading), [Publishing](#publishing) and
[Release blog posts](#release-blog-posts) (which `AGENTS.md` carried word for word as
well). This introduction and the [Release checklist](#release-checklist) are new.
The rules themselves stay in [`CLAUDE.md`](../../CLAUDE.md) and
[`AGENTS.md`](../../AGENTS.md): a version bump and a package publication happen only
when the user explicitly requests them, permission to commit or push authorizes
neither, a work item or a handoff authorizes nothing, and nothing is ever published
from a local machine. Index: [docs/agents/README.md](./README.md).

## Release actions need explicit authorization

Version bumps and package publication are separate release actions. Perform
either one only when the user explicitly requests it; permission to commit or
push does not authorize a version change or package publication. Never publish
from a local machine: npm packages are published only by the CI release jobs
through npm trusted publishing (see Publishing below).

## Release checklist

New: derived from the release-preparation commit of 2.9.21 (`2d617fd3`), the
release-post rules below and `docs/generated-api-reference.md`. A release is one
work item in [`feature_list.json`](../../feature_list.json) (for example
`release-2.9.22`); listing it there does not authorize any step below.

1. Set the root `package.json` version (only on the user's explicit request), then
   run `bun run docs:api` so the generated API reference (`/reference/`) matches
   the new version ([Release integration](../generated-api-reference.md#release-integration)).
2. Date the release's changelog section in `docs/src/content/docs/changelog.md`
   (`## [X.Y.Z] - YYYY-MM-DD`).
3. Align the pinned Docker image references with the new version in `README.md`
   and the deployment, environment-variable, installation and server guides
   (`docs/src/content/docs/guide/{deployment.mdx,env-vars.md,installation.mdx,server.md}`);
   `test/docs-docker-tags-version.test.ts` fails while one still names the
   previous version.
4. Generate and hand-write the release post ([Release blog posts](#release-blog-posts)).
5. Run the gates on the final candidate: `bun run test:sandbox`,
   `bun run test:sandbox:sdk` when `sdk/` changed since the previous release, the
   fresh Ubuntu 24.04 and Debian 13 OrbStack Machines of
   [docs/testing.md](../testing.md#orbstack-machine-isolation), and a skeptic `PASS`.
6. Push to `main` only with the user's explicit authorization; CI's version gate
   tags, releases and publishes ([Publishing](#publishing)).
7. After publication, run `bun docs/scripts/generate-release-posts.ts --refresh` and
   update the post's install box and contributors.

## Publishing

npm packages (`bunqueue` from `ci.yml`, `bunqueue-client` from
`sdk-release.yml`) are published only by GitHub Actions through **npm trusted
publishing** (OIDC, GitHub environment `npm`), with a provenance attestation and
no long-lived npm token. Bun installs, builds and packs the tarball; the npm CLI
(>= 11.5.1) dry-runs and publishes exactly that tarball, because Bun's publisher
has no OIDC or provenance support. Never run `bun publish` or `npm publish`
locally, and never reintroduce an `NPM_TOKEN` secret.

## Release blog posts

Every release gets a professional blog post at
`/blog/bunqueue-vX-Y-Z/`, in the style of Bun's release posts (bun.com/blog).
The release-preparation commit (the one that dates the changelog section) must
include it:

1. Run `bun docs/scripts/generate-release-posts.ts`. It writes a draft post for
   every dated changelog section (`docs/src/content/docs/blog/bunqueue-vX-Y-Z.md`)
   with the install/upgrade box, feature sections, bugfixes and contributors.
2. Rewrite the new release's draft by hand into a professional article: a
   description that leads with the user-visible outcome and real numbers; a
   short intro on why the release matters; one `##` section per notable change,
   titled as a claim ("Dashboards no longer cost a full scan every 10 ms") with
   prose plus before/after tables or code; then "Other improvements",
   "Bugfixes", "Thanks to N contributors!" and the link to the previous
   release. Every fact and figure must come from the changelog or real
   measurements; never invent numbers, quotes or features.
3. Delete the `<!-- Generated from changelog.md ... -->` marker from the
   rewritten post. The generator never overwrites a post without the marker.
4. After the release is tagged and published, run
   `bun docs/scripts/generate-release-posts.ts --refresh` (contributors, npm,
   Docker and GitHub release data in `docs/src/data/releaseMeta.json`), then
   regenerate and update the hand-written post's install box and contributors.

CI runs `generate-release-posts.ts --check`: a stale or missing post fails the
docs job. The GitHub release body links to the post, the blog index and RSS
list it, and the home page announces the newest release post.
