#!/usr/bin/env bash
# Shows what changed since the tree a gate passed on, and whether that gate result
# still covers it (../SKILL.md, ../references/post-gate-deltas.md). Run it; it only
# reads Git. Compatible with the bash 3.2 that macOS ships.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: gate-delta.sh --gated <tree-ish> [--current <tree-ish>] [--dry-run]
       gate-delta.sh --paths <file|->

Compares the tree a gate passed on (record it with `git write-tree` when the gate
starts) with the index (default) or with --current, and sorts every changed path:

  code  anything a gate builds, executes or parses: src/, test/, scripts/, bench/,
        examples/, sdk/, .github/, .agents/ scripts and evals, package and lock files,
        tsconfig*, bunfig.toml, Dockerfile*, docs code (docs/scripts, docs/src
        except content), JSON other than feature_list.json
  docs  Markdown and MDX outside those trees, docs/public/, feature_list.json

--paths classifies a list of repository-relative paths (one per line) without Git.
A docs delta still matters: unit tests read the docs, the changelog, the agent
harness and the skills, so the script lists the focused tests to rerun.

Options:
  --gated <tree-ish>    Tree the gate passed on (required unless --paths)
  --current <tree-ish>  Tree to compare with (default: the index)
  --paths <file|->      Classify these paths instead of asking Git
  --dry-run             Print the Git command; run nothing
  -h, --help            Show this help

Exit codes:
  0  no delta: the gate result applies to the current tree
  1  code delta: rerun the full gate (and test:model / test:sandbox:sdk when triggered)
  2  usage error
  3  docs-only delta: rerun the listed focused tests and record both tree hashes
  4  Git error (not a repository, unknown tree)
EOF
}

usage_error() {
  printf 'gate-delta.sh: %s\nRun with --help for usage.\n' "$*" >&2
  exit 2
}
need_value() { [ "$2" -ge 2 ] || usage_error "$1 needs a value"; }

gated='' current='' paths_from='' dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --gated) need_value "$1" $# && gated=$2 && shift 2 ;;
    --current) need_value "$1" $# && current=$2 && shift 2 ;;
    --paths) need_value "$1" $# && paths_from=$2 && shift 2 ;;
    --dry-run) dry_run=1 && shift ;;
    -h | --help) usage && exit 0 ;;
    *) usage_error "unknown option '$1'" ;;
  esac
done
for ref in "$gated" "$current"; do
  [ -z "$ref" ] || printf '%s' "$ref" | grep -Eq '^[A-Za-z0-9._/^~@{}-]+$' || usage_error "bad tree-ish '$ref'"
done
[ -n "$paths_from" ] || [ -n "$gated" ] || usage_error '--gated (or --paths) is required'

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)

# --no-renames: a rename is a deletion plus an addition, so both paths are classified
# (git mv src/x.ts docs/x.md would otherwise show only the docs path).
run_diff() {
  if [ -n "$current" ]; then git -C "$repo" diff --no-renames --name-only "$gated" "$current"; else
    git -C "$repo" diff --cached --no-renames --name-only "$gated"
  fi
}
if [ "$dry_run" -eq 1 ] && [ -z "$paths_from" ]; then
  if [ -n "$current" ]; then echo "gate-delta.sh: dry run; would run: git -C $repo diff --no-renames --name-only $gated $current"; else
    echo "gate-delta.sh: dry run; would run: git -C $repo diff --cached --no-renames --name-only $gated"
  fi
  exit 0
fi

if [ -n "$paths_from" ]; then
  if [ "$paths_from" = - ]; then changed=$(cat); else
    [ -f "$paths_from" ] || usage_error "no file $paths_from"
    changed=$(cat "$paths_from")
  fi
else
  git -C "$repo" rev-parse --verify --quiet "$gated^{tree}" >/dev/null || {
    echo "gate-delta.sh: not a tree in $repo: $gated" >&2
    exit 4
  }
  [ -z "$current" ] || git -C "$repo" rev-parse --verify --quiet "$current^{tree}" >/dev/null || {
    echo "gate-delta.sh: not a tree in $repo: $current" >&2
    exit 4
  }
  changed=$(run_diff) || exit 4
fi

kind() {
  case "$1" in
    src/* | test/* | scripts/* | bench/* | examples/* | sdk/* | .github/*) echo code ;;
    .agents/*/scripts/* | .agents/*/evals/* | .agents/*/assets/* | .agents/*/agents/*) echo code ;;
    docs/scripts/*) echo code ;;
    docs/src/content/*.md | docs/src/content/*.mdx) echo docs ;;
    docs/src/*) echo code ;;
    docs/public/*) echo docs ;;
    feature_list.json) echo docs ;;
    *.md | *.mdx) echo docs ;;
    *) echo code ;;
  esac
}

code=0 docs=0 shown=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  k=$(kind "$path")
  if [ "$k" = code ]; then code=$((code + 1)); else docs=$((docs + 1)); fi
  if [ "$shown" -lt 40 ]; then printf '%-4s %s\n' "$k" "$path" && shown=$((shown + 1)); fi
done <<EOF
$changed
EOF
total=$((code + docs))
[ "$shown" -ge "$total" ] || echo "... and $((total - shown)) more"

if [ "$total" -eq 0 ]; then
  echo 'gate-delta.sh: no delta; the gate result applies to this tree'
  exit 0
fi
if [ "$code" -gt 0 ]; then
  echo "gate-delta.sh: $code code path(s) changed after the gate: rerun bun run test:sandbox"
  echo '              (and bun run test:model / bun run test:sandbox:sdk when their triggers apply)'
  exit 1
fi
echo "gate-delta.sh: docs-only delta ($docs paths). Rerun the tests that read them, then record"
echo '              the gated and the current tree hash in the evidence:'
echo '  bun test test/agent-harness test/agent-skills test/docs-*.test.ts'
echo '  bun docs/scripts/generate-release-posts.ts --check'
echo '  bun run check:docs-data'
if [ -d "$repo/test" ]; then
  readers=$(printf '%s\n' "$changed" | while IFS= read -r path; do
    [ -z "$path" ] || grep -rlF --include="*.test.ts" -- "$path" "$repo/test" 2>/dev/null || true
  done | while IFS= read -r file; do printf '%s\n' "${file#"$repo/"}"; done | LC_ALL=C sort -u | head -n 20)
  [ -z "$readers" ] || printf '  bun test %s\n' "$(echo "$readers" | tr '\n' ' ')"
fi
exit 3
