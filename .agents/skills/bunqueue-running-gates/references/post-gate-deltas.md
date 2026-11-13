# Proving a post-gate delta

A gate result is evidence for one tree. When the staged tree changes after a green
gate (a changelog sentence, a progress note, a skeptic-requested doc fix), either prove
that the delta cannot change what the gate executed and rerun the tests that read it,
or rerun the gate.

## 1. Record the gated tree

When the gate starts, with everything staged and nothing outside the index:

```bash
git status --porcelain     # only first-column (staged) entries
git diff --quiet && git write-tree
```

Put that hash in the evidence next to the artifact path.

## 2. Compare with the current tree

Run, do not read, [the delta script](../scripts/gate-delta.sh):

```bash
bash .agents/skills/bunqueue-running-gates/scripts/gate-delta.sh --gated <gated-hash>
bash .agents/skills/bunqueue-running-gates/scripts/gate-delta.sh --gated <gated-hash> --current <other-hash>
```

The same comparison by hand is `git diff --cached --no-renames --stat <gated-hash>`
(index against the gated tree) or `git diff --no-renames --stat <gated-hash> <current-hash>`.
Keep `--no-renames`: without it Git reports a rename by its new path only, and
`git mv src/x.ts docs/x.md` would look like a docs-only delta.

| Exit | Meaning | Next step |
| --- | --- | --- |
| 0 | no delta | the gate result applies as it is |
| 3 | docs-only delta | rerun the focused tests it prints; record both hashes |
| 1 | a code path changed | rerun `bun run test:sandbox` (and the model or SDK gate when triggered) |
| 4 | Git error | fix the hash; nothing is proven |

Docs-only means Markdown and MDX outside the code trees, `docs/public/` and
`feature_list.json`. Everything else counts as code, including JSON, `docs/src` code,
`.agents/` scripts, evals and assets, and the `.claude/skills` symlinks: the unit suite
parses them.

## 3. Rerun what reads the delta

Docs are not inert: the unit suite runs the agent-harness and skills contracts, the
changelog and release-post checks, and the documentation tests. For a docs-only delta
run at least:

```bash
bun test test/agent-harness test/agent-skills test/docs-*.test.ts
bun docs/scripts/generate-release-posts.ts --check
bun run check:docs-data
```

plus every test file the script lists as reading a changed path. These run on the
host, so they are diagnostic for environment issues; the gated tree still carries the
container evidence.

## 4. Optional: compare with the image

`bun run test:sandbox` builds the image `bunqueue-test:local`. Its `/workspace` is
exactly what the unit container tested, so a byte comparison proves which files the
gate saw. Do it before any other sandbox run overwrites the tag:

```bash
dir=$(mktemp -d)
id=$(docker create bunqueue-test:local)
docker cp "$id:/workspace/." "$dir/"
docker rm "$id"
git diff --cached --no-renames --name-only <gated-hash> | while read -r path; do
  cmp -s "$path" "$dir/$path" && echo "same $path" || echo "differs $path"
done
rm -rf "$dir"
```

`/workspace` also holds `node_modules` and build output that the worktree does not, and
it lacks every path `Dockerfile.test.dockerignore` excludes, so compare only the changed
paths, never the whole tree.

## Evidence wording

```text
Gate on staged tree <gated-hash> (artifacts/test-sandbox/<timestamp>/). Final staged
tree <current-hash>: docs-only delta (gate-delta.sh exit 3: <paths>); reran
bun test test/agent-harness test/agent-skills test/docs-*.test.ts <n> pass / 0 fail,
generate-release-posts.ts --check OK, check:docs-data OK.
```
