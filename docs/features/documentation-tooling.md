# Documentation Tooling

The public documentation site is an Astro/Starlight project under
`docs/src/content/docs/`. Repository scripts keep generated API metadata,
social images, and executable documentation claims reproducible.

## Framework versions and upgrade constraints

`docs/package.json` pins the site to Astro 7.3 (Vite 8 with Rolldown and the
Rust compiler), Starlight 0.42, `@astrojs/react` 7, `@astrojs/sitemap` 3.7,
`@astrojs/markdown-remark` 7.3 and `sharp` 0.35.5. These are security floors,
not just current releases: Astro below 7.2.8 and `sharp` below 0.35.4 carry
known advisories (AVIF image-optimization RCE, base-path authorization bypass
and XSS in Astro; libvips and libheif CVEs in `sharp`), and Starlight 0.42
requires Astro 7.2.10 or later. Astro 7 needs Node.js 22.12.0 or later, the
same floor as Astro 6, so the Vercel project and the CI docs job are
unchanged. `docs/bun.lock` must resolve a single `sharp` at or above 0.35.4.
The build currently feeds no raster image through Astro's image service (the
logo is SVG and screenshots are served from `public/`), but `sharp` remains
Astro's optional image backend and is kept patched.

- **Markdown pipeline.** Astro 7 defaults to the Sätteri processor. The site
  keeps `markdown.processor: unified({ gfm: true })` from the explicitly
  declared `@astrojs/markdown-remark`, so heading anchors, Starlight asides and
  Expressive Code blocks render exactly as before. `@astrojs/mdx` 8 (bundled by
  Starlight) inherits `gfm` from that processor, which is why the deprecated
  top-level `markdown.gfm` flag is gone. Without `gfm: true`, every GFM table
  renders as literal `|---|` text. Moving to Sätteri is a separate change that
  must be checked against every anchor and aside.
- **Whitespace.** `compressHTML: true` is explicit. Astro 7 otherwise defaults
  to `'jsx'`, which strips spaces between inline elements.
- **Build log.** A clean build prints no warnings. `vite.build.rolldownOptions.onwarn`
  drops only Rolldown's `MODULE_LEVEL_DIRECTIVE` warning for the dead
  `"use astro:head-inject"` directive that Astro 7.3 still adds to every MDX
  `?astroPropagatedAssets` module. Remove the filter once Astro stops emitting
  that directive. `src/content/i18n/en.json` is an intentionally empty
  Starlight UI-string override. Starlight always queries an `i18n`
  collection. Under Astro 7 a missing collection logs "collection i18n does
  not exist or is empty" on every build, because Starlight's `console.warn`
  silencing no longer reaches Astro's logger.
- **Mobile menu.** Starlight 0.42 renders the drawer toggle as a bare
  `.sl-menu-button` that opens the `#starlight__sidebar` popover. The
  `<starlight-menu-button>` wrapper, its `aria-expanded` attribute and the
  `data-mobile-menu-expanded` body attribute no longer exist. Style the open
  state with `.sl-menu-button:has(~ :popover-open)`. While the drawer is open,
  Starlight marks `.main-frame` as `inert`.
- **Sidebar width.** Starlight 0.39+ sets `scrollbar-gutter: stable` on the
  sidebar pane. With the site's classic 8px `::-webkit-scrollbar`, Chromium
  would reserve that width permanently and wrap longer labels, so
  `docs-navigation.css` resets the pane to `scrollbar-gutter: auto`.
- **Tabs.** Starlight 0.41.8 made tab ids page-scoped (`tab-0-0`, not a global
  `tab-N`). Do not link to generated tab ids.

After any framework upgrade, require a warning-free `bun run build`, the docs
unit tests, a link and anchor check over `docs/dist`, and before/after
screenshots of the homepage, a guide, the changelog and the mobile drawer in
both themes.

## Open Graph image generator

`docs/scripts/generate-og.ts` owns SVG rendering, font loading, lane artwork,
and PNG output. Static page copy and image metadata live separately in
`docs/scripts/og-covers.ts`; adding or changing a cover does not expand the
rendering pipeline or require an unsafe payload cast.

Run the generator from `docs/scripts/` so its relative font and output paths
resolve as documented:

```bash
bun generate-og.ts
```

It writes generated PNGs below `docs/scripts/out/`. Generated output is copied
to `docs/public/` only when the corresponding public asset is intentionally
being refreshed. Both source modules must remain below the repository's
300-line limit and pass Oxlint and Oxfmt together.

## Static analysis and formatting

The root project and TypeScript SDK use pinned Oxlint and Oxfmt releases.
Oxlint reads `.oxlintrc.json`, enables type-aware rules through the pinned
`oxlint-tsgolint` companion, and keeps intentional queue-specific exceptions in
scoped overrides or `oxlint-disable-next-line` directives. Oxfmt reads
`.oxfmtrc.json` and preserves the existing two-space, single-quote, semicolon,
100-column style.

The migration keeps the former prototype-call, switch-fallthrough, and array
constructor checks through Oxlint's `no-prototype-builtins`, `no-fallthrough`,
and `no-array-constructor` rules. Oxc has no exact equivalents for Biome's
`noArguments`, `useIterableCallbackReturn`, `noGlobalIsNan`, or
`useConsistentEnumValueType`; the nearest applicable checks remain enabled as
`prefer-rest-params`, `array-callback-return`, `use-isnan` through the
correctness category, and `typescript/no-mixed-enums`. These are intentional
semantic approximations rather than a claim that the two rule sets are
identical. The SDK similarly uses `typescript/no-empty-object-type` as the
supported replacement for Biome's broader `noBannedTypes` rule.

Run `bun run check:oxc` at the repository root. The TypeScript SDK exposes the
same check as `bun run check` from `sdk/typescript/` and owns nested Oxc configs
so it also works as a standalone checkout. CI, the pre-commit hook, and both
isolated validation images invoke these same scripts.

## Generated API reference

`bun run docs:api` generates the current minor's TypeDoc tree from every public
package entry point. TypeDoc reads `tsconfig.typedoc.json` so the optional MCP
export is included even though the production type-check configuration excludes
that subtree. Private and protected implementation members stay out of the
published surface.

Generation treats warnings as errors. A type reachable from a public signature
must either be documented through a real entry point or listed as a deliberate
internal structural helper in `typedoc.json`; an unmatched entry-point pattern or
unresolved type link blocks the release. Older minor trees receive
`noindex, follow` at generation time; the current tree receives it when the site
is built, and no generated page joins the sitemap. The complete contract and
versioning rationale live in [Generated API Reference](../generated-api-reference.md).

## LLM discovery outputs

`docs/public/llms.txt` is the curated, low-token documentation index.
`/llms-full.txt` is generated from the content collection and includes every
non-blog documentation page except the 404 route, with a title, description,
canonical URL, and source body. When an MDX page renders a tracked `?raw`
import through Starlight's `Code` component, the generator replaces the MDX
variable with the actual source in a fenced block. It fails the build if the
import has no code destination or cannot be read, preventing an apparently
complete dump from silently omitting executable examples.

Pages follow the `ORDER` list in `docs/src/pages/llms-full.txt.ts`; pages it
does not name are appended alphabetically after it. A section split into
several pages lists them right after its hub: the TCP protocol overview
(`api/tcp`) is followed by its eight command pages (`api/tcp/jobs`, `queries`,
`control`, `dlq`, `cron`, `flows`, `monitoring`, `workers`). The overview keeps
the wire format, connection, negotiation, pipelining, authentication, response
format, connection lifecycle and limits, plus a command summary whose rows link
to each command's section, so a new TCP command needs a section on its family
page and a linked summary row.

`docs/public/robots.txt` advertises the curated and full-text endpoints and the
sitemap index. Astro's sitemap integration emits only canonical indexable
routes, derives per-page `lastmod` values from Git history when available, and
omits the 404, Markdown mirrors, Open Graph images, and text endpoints.

## Progressive examples and interactive explainers

`docs/src/content/docs/examples.mdx` is ordered as a learning path. It begins
with one embedded queue and worker, adds lifecycle and reliability controls,
introduces process boundaries, and ends with workflows and the PostgreSQL
multi-broker project. Existing section headings retain their anchors when the
reading order changes, so inbound links remain valid.

The page's small visual system lives under `docs/src/components/examples/`.
`ExamplesLearningPath.astro` provides direct anchor navigation, while
`JobJourney.astro` and `TopologyExplorer.astro` use guarded custom elements for
progressive enhancement. Their first server-rendered state is meaningful
without JavaScript. Native buttons, `aria-pressed`, `aria-current`, live status
text, visible keyboard focus, and reduced-motion styling are required parts of
the component contract.

`explainerModels.ts` is the shared source for lifecycle routes and deployment
topologies. `test/docs-examples-page.test.ts` verifies the page order, anchor
targets, model boundaries, topology progression, accessibility hooks, and the
300-line file limit. The unit validation image copies only this explicit
component subtree in addition to the documentation content already required by
the test suite.

## Homepage onboarding

The homepage at `docs/src/content/docs/index.mdx` opens with the cross-language
value proposition, presents the bunqueue Academy video course, introduces the
web dashboard, shows public projects that use bunqueue, and then reaches the
quickstart before storage or advanced features.
Its existing `#quickstart` anchor opens with a segmented switch between two
paths, each laid out as three numbered steps joined by a connector line: the
explanation sits in a left column (sticky on wide screens) and the commands and
code on the right. The server path is "Start the server" (Docker or Bun CLI,
explicit loopback TCP/HTTP ports), "Connect your app and worker" with a complete
program for every official SDK (Node.js, Bun, Deno, Python, PHP, Go, Rust and
Elixir) that connects to `127.0.0.1:6789`, adds one job and prints it from the
worker, and "See it work" with the expected worker output. The Bun embedded path
sets `embedded: true` on both clients. The SQLite server example binds to
loopback and explicitly enables persistence; the embedded example describes its
ephemeral default. Every command and program of both paths comes from one
module, `src/data/firstJob.ts` (install command, files and run command per
runtime, plus the Docker and Bun CLI server commands and the health check), and
is rendered by `components/FirstJobCode.astro`; `HomeDockerQuickstart.astro`
builds its Docker variants from the same module. `/guide/quickstart/` renders the
same examples at its top, so the header's "Get started" and the homepage's "Run
your first job" lead to identical, tested files, and the README's quickstart
repeats them verbatim. The SDK programs target the released SDK packages
(constructor options, job data access, blocking `run`), except Elixir, which
uses a path dependency on a bunqueue checkout until its Hex release. Every Go
example on the site that indexes job data does it through
`any(job.Data()).(map[string]any)`, which compiles against both `sdk/go`
v0.1.0 (`Data() map[string]any`) and v0.2.0 (`Data() any`); examples that pass
`job.Data()` along whole compile against both as is. Recheck the programs when
an SDK release changes its public API. `test/docs-homepage-snippets.test.ts`
checks that every runtime has an install command, files and a run command,
compiles the two TypeScript programs (Deno and embedded Bun), and fails if the
README's Bun and Node.js examples, or the `bunqueue-client` README's quick start
(Docker and Bun CLI server commands, health check, Node.js file), drift from the
module.

`components/home/HomeHero.astro` owns the headline ("Add a background job in
one language. Process it in another.", which keeps the primary keyword in the
H1), the MIT link, two "New" announcements that jump to the `#academy` and `#agents`
sections, the two calls to action and the three included-with-bunqueue facts.
`HomeLedger.astro` renders the hero's simulated `orders` queue: five jobs, each
added from one client language and processed by a worker in another, move
through `waiting`, `delayed`, `active`, `retry` and `completed`. The
server-rendered snapshot already shows every state, so it is the picture that
stays when `prefers-reduced-motion: reduce` is set at load; pausing, or turning
reduced motion on while the page is open, freezes the rows in their current
state. Otherwise a small script
advances the rows every 900 ms, fills each active row by its progress, fails
`charge-card` once before its retry, and recycles completed rows with new job
names. It runs only while the ledger is on screen, the tab is visible, reduced
motion is off (re-evaluated when the preference changes) and the viewer has not
pressed the Pause button, which satisfies WCAG 2.2.2 for auto-updating
content. The rows are decorative (`aria-hidden`) and carry `data-nosnippet`, so
simulated job names never appear in search snippets; the caption states that
the data is simulated and stays indexable.

`HomeAcademy.astro`, directly below the hero (anchor `#academy`), presents
bunqueue Academy, the free video course on the `@bunqueue` YouTube channel: the
60-second overview (episode 00) in a player beside the copy, counters derived
from the episode data (episodes out, total running time, episodes still to
come), calls to action for `/academy/` and the YouTube playlist, a grid of the
released lessons linking to their `/academy/#episode-NN` anchors, and a
"Coming next" row. Its styles live in `styles/home-academy.css`.

Every episode is declared once in `src/data/academy.ts`: number, title, topic,
summary, the guide it follows and, once public, its YouTube video ID and running
time. An episode without a `videoId` is announced as coming soon and never
embedded. Publishing an episode means adding its `videoId` and `duration`, an
`uploadDate` when it differs from `ACADEMY_UPLOAD_DATE` (the structured-data
default), and its thumbnail as a local 960x540 JPEG in `public/academy/NN.jpg`
(episode number, zero-padded); nothing checks the thumbnail at build time.
The `/academy/` page (`content/docs/academy.mdx`, linked as "Video Course" in
the sidebar and as "Academy" in the header) renders the full list through
`components/academy/AcademyCourse.astro`, which also emits `ItemList` +
`VideoObject` structured data for the released episodes.
`components/academy/GuideEpisode.astro` places an episode under the hero of the
guide it follows (introduction, queue, worker, cron, DLQ and flow overviews) and
renders nothing until that episode has a `videoId`. On `/guide/quickstart/` the
episode follows the first job instead, as "Prefer to watch?", so the first
command is visible without scrolling.

All videos use `components/VideoPlayer.astro`, a click-to-load player: the page
ships only the local thumbnail and a button, and the privacy-enhanced
`youtube-nocookie.com` iframe is created on the first click, so no third-party
request happens before the reader chooses to play. Players above the fold
(under a guide hero, the first episode on `/academy/`, the dashboard guide) load
their thumbnail eagerly. Its styles live in the global `styles/video-player.css`,
because the iframe is created at runtime and scoped styles would not reach it; it
also styles the captioned `.bq-video-figure` used under guide heroes. The play
button's focus ring is drawn inside the clipped frame, overriding the homepage's
outward focus offset so keyboard focus stays visible.

`HomeAgents.astro`, below the Academy section (anchor `#agents`), presents the
MCP server's opt-in agent features: the copy with a `claude mcp add` command that
enables toolsets and confirmation, an example confirmation exchange (the agent's
`bunqueue_obliterate_queue` call, the server's impact text, the user's decline and
the `executed: false` refusal, all worded as the server words them), three
columns keyed by the variable that turns each feature on
(`BUNQUEUE_MCP_TOOLSETS`, `BUNQUEUE_MCP_CONFIRM`, `BUNQUEUE_MCP_DECISION_*`) and
the supported decision models (Jev, Clef, Clef-flash, Kev 9B, Laya,
DiffusionGemma Jev, with where each one runs). Its figures (75 tools, 11
toolsets, 1,300 to 4,600 tokens instead of about 16,000, nine guarded tools)
come from `guide/mcp.mdx`; update both together. Its styles live in
`styles/home-agents.css`, whose selectors include `.home-agents` so the
transcript's inline code outranks the site-wide inline-code chip in
`custom.css`.

`/guide/mcp/` has two diagrams, both plain HTML in reading order (no canvas or
SVG text) inside a `.not-content` figure, drawn with the theme tokens
(`--docs-line`, `--docs-panel`, `--docs-muted`, `--docs-accent`, and the
`--docs-state-*` job-state palette) so they follow dark and light mode. Each
figure is its own query container, so the layout follows the figure's width,
not the window's (the content column is only about 500 to 700px wide between
800 and 1280px windows): left to right from 44rem (architecture) or 46rem (handler
flow), stacked below. `McpArchitecture.astro` shows where the queue
lives: the AI client, the stdio or Streamable HTTP link, `bunqueue-mcp` (the only
node in the brand color) and a fork to the embedded and TCP modes. The fork's
bar and branches are drawn on the mode list itself so they meet the card centers
at every width (on phones one spine on the left ends in a branch into each mode
card); its styles are in `styles/mcp-architecture.css` (global, every class name
starts with `mcpd`). `HttpHandlerFlow.astro` shows a handled job as four numbered
steps with chips in the job-state palette (waiting, active, completed, failed).
Their figures (75 tools, 3 prompts, 5 resources, port 6789, the HTTP methods,
which methods send a body, `timeoutMs`) come from `guide/mcp.mdx` and
`src/mcp/httpHandler.ts`; update them together. Inline code inside these
figures is styled with `.<root>.not-content :not(pre) > code`, because
`custom.css`'s global inline-code chip also reaches `.not-content` blocks.

`HomeDashboard.astro`, below the agents section, introduces the separately
released [bunqueue dashboard](https://github.com/egeominotti/bunqueue-dashboard):
the 7:46 full-tour video in the click-to-load player (thumbnail
`public/dashboard/tour-thumbnail.jpg`), the `bunx bunqueue-dashboard` command
with its default ports, four capability rows, and links to `/guide/dashboard/`,
the live demo and the repository. Its styles live in
`styles/home-dashboard.css`, which includes the section's own tablet and phone
breakpoints.

The guide page `guide/dashboard.mdx` opens with the same full-tour video (anchor
`#tour`), then uses `components/DashboardArchitecture.astro`,
a static diagram of browser, dashboard process and server whose figcaption
carries the full description and which stacks through a container query when
its own width falls below 760px (the table of contents narrows the column),
and the `.bq-shot` figure style from `docs-reading.css` for captioned
screenshots; the Overview screenshot is the static WebP
`public/dashboard/overview.webp`, converted from the dashboard repository's own
screenshots. Facts on that page come from the
dashboard repository's README, user guide and known-issues page; recheck them
when the dashboard changes its defaults, ports or fail-closed operations.

`HomeUsedBy.astro`, below the dashboard section, lists public GitHub repositories
that import bunqueue in their own source. Each row names the repository, its
GitHub star count, its purpose and how it uses bunqueue, with no logos or
implied endorsement, and the section links to GitHub's dependents graph. Star
counts are a dated snapshot in the component (rounded down to one decimal in
thousands) and are refreshed by hand; the build makes no GitHub requests. Add a
project only after confirming that its default branch depends on bunqueue.

`HomeDetails.astro` owns capabilities, storage choices, BullMQ migration links
and FAQs. Capabilities follow a job's lifecycle (before it runs, while it runs,
when it fails, after it completes), and each stage reuses the matching state
color from the ledger. Storage is presented as a path from `:memory:` through
SQLite to PostgreSQL. The FAQ answers and JSON-LD share one data source.
`HomeDockerQuickstart.astro` provides the default server setup, with four Linux
base-image variants presented as pill tabs inside step 1, copyable Docker commands, loopback port mappings, a persistent
named volume and an HTTP readiness check. Starlight's Code component supplies
copy controls. The Bun CLI remains available in its own tab. Moving image tags
are identified explicitly; deployment guidance recommends a version or digest.

Homepage styles are scoped through `.bq-home`. `styles/home.css` defines the
tokens, including one color per job state for dark and light themes, the type
scale and the hero; `styles/home-ledger.css` styles the simulation;
`styles/home-setup.css` covers section intros and shared setup elements
(connection facts, notes, callouts, tabs); `styles/home-quickstart.css` covers
the quickstart steps, the segmented mode switch, the base-image pills and the
expected-output panel;
`styles/home-sections.css` covers projects, lifecycle, storage, migration, FAQ
and closing; `styles/home-academy.css` covers the Academy section and
`styles/home-dashboard.css` the dashboard section;
`styles/home-responsive.css` holds the tablet and phone layouts.
The h1 and h2 headings use the self-hosted Bricolage Grotesque at 75% width
(its `wdth.css` axis file is imported by `HomeHero.astro`, and
`components/Head.astro` preloads the latin width-axis file on the homepage only
so the headline does not reflow when the font arrives); h3 headings keep its
normal width. Body copy inherits Starlight's Inter, IBM Plex Mono is reserved
for job data and code, and the pink identity marks the active state and
primary actions. Internal links carry no arrow; the "Source on GitHub" button
and the GitHub dependents link carry `↗`. Lists styled without markers keep
`role="list"` so VoiceOver still announces them as lists.

The shared footer also states the distinction between engine and client runtimes.
The generated homepage social card uses its page title and a free/open-source
eyebrow, including when the hero is rendered through an Astro component.
Native Starlight tabs and HTML disclosures provide keyboard interactions;
theme tokens, visible focus states and reduced-motion rules cover both themes.
The two setup choices fit without horizontal scrolling on narrow screens.

`test/docs-homepage-snippets.test.ts` reads the first-job examples from
`src/data/firstJob.ts` and compiles each TypeScript program as an independent
virtual module against the real public engine and network-client exports. This catches missing job payload types and
API drift without duplicating the examples. The unit validation image includes
the TypeScript SDK source subtree and its README for that check; it does not copy
SDK caches or install an additional SDK dependency tree.

Validate changes with the snippet regression, docs build/discovery checks and browser inspection
of server/client tabs, embedded mode, FAQs, desktop/mobile layouts, and both
themes. No queue lifecycle or SDK implementation changes are involved.

## Search indexing and canonical URLs

`docs/src/lib/reference-seo.ts` collects the current version's TypeDoc HTML and
adds canonical URLs, page-specific titles/descriptions and a single
`noindex, follow` robots meta to the build output; none of those pages join the
sitemap, so crawling goes to the hand-written pages (see
[Generated API Reference](../generated-api-reference.md) for the Search Console
evidence). It leaves the tracked generated sources untouched.
It also gives every current reference page `og:image` and `twitter:image`
(the site-wide `/og-image.png`), because TypeDoc emits no social image.
Historical reference trees retain their generated `noindex, follow` metadata;
the hosting configuration only adds `noindex` to raw Markdown mirrors.
`docs/src/lib/sitemap.ts` owns sitemap priorities and real Git modification dates.

`docs/vercel.json` sets `trailingSlash: true`, so a page URL without its slash
answers with a 308 redirect to the canonical URL instead of a duplicate 200;
paths with a file extension, such as TypeDoc `.html` pages, are not redirected.
`docs/src/routeData.ts` is Starlight route middleware: when a page title already
contains "bunqueue", it drops Starlight's ` | bunqueue` suffix so the brand is
not repeated and the title stays within search-result width. Meta descriptions
are kept at 160 characters or fewer. The changelog limits its page outline to
release (`##`) headings, which keeps its desktop and mobile tables of contents
small. The `www.bunqueue.dev` to `bunqueue.dev` redirect is a Vercel domain
setting rather than repository configuration and should be permanent (308).

`test/docs-seo.test.ts` covers the hosting policy, deterministic current-only
page discovery, escaped/idempotent metadata, and actual temporary build output.
The discovery validator checks authored pages against the sitemap, requires every
current reference page to carry `noindex`, a self canonical and unique metadata,
and verifies historical exclusion. See
[Generated API Reference](../generated-api-reference.md) for the version policy.

## Shared documentation interface

`styles/docs-theme.css`, imported last by `Header.astro` together with the
width axis of Bricolage Grotesque, sets the documentation's look: a translucent
header; page titles and H2s in the homepage's condensed Bricolage Grotesque
(`font-stretch: 75%`), without the hero eyebrow and with the title in one color;
inline code as a neutral chip; callouts with one thin border and a faint wash in
the homepage's job-state colors (note = delayed, tip = completed, caution =
retry, danger = failed), plus `--docs-state-waiting` and `--docs-state-active`
so diagrams can show every job state; a header row with no labels hidden; tabs,
steps, pagination, the sidebar and the table of contents marking the current
item with a pink rail. Every rule in `docs-theme.css` and `docs-reading.css` that
styles headings, paragraphs, links, inline code or tables inside
`.sl-markdown-content` skips `.not-content` blocks, as Starlight's own Markdown
styles do, so widgets such as the queue simulator keep their own typography;
`test/docs-theme-not-content.test.ts` fails on any such rule without the
exclusion. Code blocks are configured in `docs/ec.config.mjs`, not in
`astro.config.mjs`: GitHub dark/light themes on the docs surface, shell blocks
without the terminal window frame, and file names on a tab underlined in pink.
They live there because their theme-aware style functions are not
JSON-serializable and the `<Code>` component (used by `FirstJobCode.astro`)
loads its options from that file. `inlineFirstJobCode` in `src/lib/llms-full.ts`
expands `<FirstJobCode>`, the shared server commands and string-literal inline
code into Markdown for `/llms-full.txt` and every page's Markdown twin
(`/<slug>.md`, the "View Markdown" link), so those carry the code itself
(`test/docs-llms-full.test.ts`).

`Header.astro` owns the header links (Academy, AI Agents, Dashboard and Blog);
`MobileMenuFooter.astro` repeats them in the mobile drawer, so a new header link
belongs in both. "vs BullMQ" lives in the sidebar's Start Here group and the
footer, the simulator in Resources and the footer, and `llms.txt`, which is for
AI tools, in the footer's Docs column next to the MCP server.

The sidebar (`astro.config.mjs`) is organized for a first-time reader in 11
groups: Start Here (Quick Start first, with a "1 min" badge, then Introduction,
Installation, the video course, Simple Mode, use cases, BullMQ migration and
comparison, FAQ), Queue, Worker, Cron, Retries & Flows (Cron & Schedulers, Dead
Letter Queue and Flow Producer as subgroups), Workflow Engine, AI Agents (MCP
server and the agent integrations), SDKs & Integrations, Run in Production,
Examples (the PostgreSQL multi-broker pages as a subgroup), Reference (with
TCP Protocol, Performance and Internals subgroups) and Resources. Blog posts are listed on
`/blog/` only. Regrouping never changes a page's URL; every other new page needs
a sidebar entry. `Header.astro` also loads the
shared navigation, reading and table styles from
`docs-navigation.css`, `docs-reading.css` and `docs-tables.css`. They retain
Starlight's search, sidebar persistence, tab synchronization, mobile drawer,
and active table-of-contents tracking. Reading styles use `data-has-sidebar`
to keep guide typography independent of the homepage's introductory layout.
Language strips retain native scrolling without a permanent fade that masks
the final selected tab; overflowing strips show a thin scrollbar.

`DocsContext.astro` derives breadcrumbs from the current Starlight sidebar
tree and links to the existing Markdown/MDX source route. Blog posts are not in
the sidebar (the sidebar links only the `/blog/` index), so for them it adds a
"Blog" crumb that leads back to the post list. Below 50rem the source link and
the hero eyebrow (which repeats the breadcrumb) are hidden, so the title starts
higher on phones. `PageTitle.astro`
renders the context above standard headings; `MarkdownContent.astro` renders
it before pages with a custom hero. The homepage owns its single visible H1.
Custom hero pages receive a visible `#_top` focus target so the skip link and
overview anchor do not lead into Starlight's hidden title panel.

`src/lib/rehypeTableLabels.ts`, registered as a rehype plugin on the Markdown
processor (MDX inherits it), copies each column header's text onto the cells
below it as `data-label` and gives the table explicit ARIA roles. Below 600px
`docs-tables.css` turns every such table into one card per row: the first cell
and the last one span the card, the cells in between sit two by two, each
printing its column name above its value, and long identifiers wrap, so no
reference table scrolls sideways on a phone; the visually hidden header row and
the roles keep the table announced as a table. Tables with more than 40 rows
(index tables such as the TCP command summary) get roles but no labels, so they
stay tables that scroll sideways rather than a hundred cards.

Paragraphs, lists, block quotes and definition lists in guides are capped at
`56ch`. With Inter at 16px a `ch` (the width of "0") is about 10.1px while an
average character of body text is about 7.5px, so the cap holds about 75
characters per line; code blocks, tables, asides and diagrams keep the full
column.

`DocsTables.astro` wraps authored tables in scroll regions without changing
their table semantics. Only overflowing regions become focusable landmarks,
with a label derived from their nearest preceding heading. A ResizeObserver
updates this state when the viewport or a tab changes and disconnects before
Astro page swaps. CSS retains scrolling when JavaScript is unavailable.

Introduction and installation copy explicitly separate the Bun engine from
client runtimes and link new readers to the server/embedded setup choices.
Verify shared changes on guide, SDK, API and blog pages in both themes, with
keyboard navigation, wide tables, search, and a narrow mobile viewport.

`src/styles/custom.css` is the site-wide stylesheet registered as Starlight
`customCss`. Besides the theme tokens and Starlight overrides it holds the
`bq-*` primitives that authored pages and scripts use directly: the page hero
and wrapper, the `bq-diag-*` diagrams, cards and bar charts, blog cards, the
`bq-cl-*` changelog feed built by `public/bq-changelog.js`, the tooltip layer of
`public/bq-inter.js`, the `bq-sim-*` workflow simulations and the
`hp-code-window` terminal frame of the workflow guides. The rules of earlier
homepage designs (the bento, stats, mode, feature and call-to-action sections
of the `hp-*` landing page with its `sc-*` syntax colors, the hero grid and
benchmark card, the first queue simulator's lanes, the step list, and the
terminal, language, trust and vs-BullMQ cards) were removed once no page,
component or script referenced their classes. Before deleting a rule as unused,
search for its class in `docs/src`, `docs/public`, `docs/scripts` and
`astro.config.mjs`, in class names built at runtime (template literals in
components, `classList` calls in `public/*.js`) and in the markup that Starlight,
Expressive Code and Pagefind generate (`sl-*`, `ec-*`, `pagefind-ui__*`, `hero`,
`card`); a class inside `:not()` does not make a selector dead.

## Release checks

- `bun run check:docs-data` verifies generated documentation metadata and
  resolves local module imports after removing Vite query or fragment suffixes
  such as `?raw`, so executable source imports remain tracked-file checked.
- `bun run docs:api` rebuilds the versioned TypeDoc reference.
- `bun run build` from `docs/` builds the complete public site and search
  index, then runs `scripts/validate-discovery.ts`. The validator compares the
  full-text and sitemap URL sets with the content tree, detects duplicates and
  stale curated links, proves every raw executable source is inlined, checks
  multi-broker reading order, and verifies the robots discovery pointers.
- `Dockerfile.test` copies the full-text transformer and the executable
  PostgreSQL multi-broker example into the sanitized unit image. This keeps the
  discovery regressions plus CLI, timeout, HTTP-bound, multi-phase cleanup, and
  verifier failure-path tests inside the same isolated gate as the repository.
  Its Dockerfile-specific ignore allowlist admits only that example subtree,
  not unrelated examples or host files.
- The tracked root and `docs/bun.lock` files are the frozen dependency inputs
  for CI, the documentation build, and both disposable validation images; a
  release snapshot must never rely on an ignored local lockfile.
- The executable guide contract is mapped in
  [Documented Feature Verification](./documented-feature-verification.md).
