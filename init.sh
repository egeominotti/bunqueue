#!/usr/bin/env bash
# Startup check for coding-agent sessions (docs/agents/README.md).
#
#   ./init.sh          pinned Bun, frozen lockfile, bun check, bun fmt, diff check,
#                      harness and skills contracts, work items, skills
#   ./init.sh --full   the same, then the full gate: bun run test:sandbox
#
# It stops at the first failure. It is not a commit gate (bun run test:sandbox is),
# but a green run is part of the Definition of Done in CLAUDE.md / AGENTS.md.
# It writes ignored output: bun install (node_modules) and the typecheck:prepare
# step of bun run typecheck (sdk/typescript/dist, dist, docs/node_modules).
# Without a Git checkout (a sanitized Machine snapshot) the git steps are skipped.
set -euo pipefail

full=0
case "${1:-}" in
  '') ;;
  --full) full=1 ;;
  -h | --help)
    sed -n '2,12p' "$0"
    exit 0
    ;;
  *)
    echo "init.sh: unknown option '$1' (use --full or --help)" >&2
    exit 2
    ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")"
started=$SECONDS

step() {
  echo
  echo "=== $* ==="
}

# A Git checkout rooted here (a worktree's .git is a file, so ask git itself).
has_git=0
if command -v git >/dev/null 2>&1 &&
  [ "$(git rev-parse --show-toplevel 2>/dev/null || true)" = "$(pwd -P)" ]; then
  has_git=1
fi

step 'Workspace'
echo "dir:    $(pwd)"
if [ "$has_git" -eq 1 ]; then
  branch=$(git branch --show-current)
  echo "branch: ${branch:-(detached)}"
  echo "HEAD:   $(git log -1 --format='%h %s' 2>/dev/null || echo '(no commit)')"
else
  echo "git:    no Git checkout here; the git steps are skipped"
fi

step 'Bun version (pinned in .github/workflows/ci.yml)'
expected=$(sed -nE "s/^[[:space:]]*BUN_VERSION:[[:space:]]*['\"]?([0-9][^'\"[:space:]]*)['\"]?.*/\1/p" \
  .github/workflows/ci.yml | head -n 1)
if [ -z "$expected" ]; then
  echo "init.sh: no BUN_VERSION found in .github/workflows/ci.yml" >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "init.sh: bun is not installed; install Bun $expected (https://bun.sh)" >&2
  exit 1
fi
actual=$(bun --version)
if [ "$actual" != "$expected" ]; then
  echo "init.sh: bun $actual is installed, but CI pins BUN_VERSION=$expected." >&2
  echo "         Install it with: curl -fsSL https://bun.sh/install | bash -s bun-v$expected" >&2
  exit 1
fi
echo "bun $actual (matches CI)"

step 'Dependencies: bun install --frozen-lockfile'
bun install --frozen-lockfile --ignore-scripts

step 'Type check: bun run typecheck (bun check)'
bun run typecheck

step 'Format: bun run format:check (bun fmt)'
bun run format:check

step 'Whitespace: git diff --check (unstaged and staged)'
if [ "$has_git" -eq 1 ]; then
  git diff --check
  git diff --cached --check
  echo "clean"
else
  echo "skipped: no Git checkout (run git diff --check on the host before the snapshot)"
fi

step 'Harness and skills contracts: bun test test/agent-harness test/agent-skills'
bun test test/agent-harness test/agent-skills

if [ "$full" -eq 1 ]; then
  step 'Full gate: bun run test:sandbox'
  bun run test:sandbox
fi

step 'Work items (feature_list.json)'
bun -e '
const { features } = await Bun.file("feature_list.json").json();
const show = (status) => features.filter((item) => item.status === status);
for (const status of ["in-progress", "blocked"]) {
  for (const item of show(status)) {
    console.log(`${status.padEnd(11)} ${item.id}${item.branch ? ` (branch ${item.branch})` : ""}`);
  }
}
const ready = show("not-started").filter((item) =>
  item.dependencies.every((id) => features.find((other) => other.id === id)?.status === "done")
);
for (const item of ready) console.log(`ready       ${item.id}`);
'

step 'Agent skills (.agents/skills; docs/agents/README.md#skills)'
for skill in .agents/skills/*/SKILL.md; do
  [ -e "$skill" ] || continue
  skill=${skill#.agents/skills/}
  echo "${skill%/SKILL.md}"
done

echo
echo "init.sh: green in $((SECONDS - started)) s"
echo
echo 'Next steps:'
echo '1. Read progress.md (Current State and the newest Session Log entry).'
echo '2. Pick ONE item from feature_list.json and set it in-progress with your branch.'
echo '3. Stay in scope; record unrelated findings as new not-started items.'
echo '4. Before committing, run the full gate: bun run test:sandbox (plus test:model /'
echo '   test:sandbox:sdk when triggered) and get a skeptic PASS.'
echo '5. Nothing here authorizes a commit, push, version bump or release.'
