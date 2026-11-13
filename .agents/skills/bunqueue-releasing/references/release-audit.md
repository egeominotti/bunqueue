# Release audits: Upgrade notes and numbers

Two checks the skeptic repeats on every release candidate. Do them first, with the
commands below, so the review finds nothing new.

## Upgrade notes audit

Upgrade notes list every change in behavior a user of the previous release can
observe, so that nobody learns about it from an incident. Build the list from the code,
not from the Features section:

```bash
prev=$(git describe --tags --abbrev=0 --match 'v*' HEAD)    # e.g. v2.9.21
git diff --stat "$prev"..HEAD -- src/                        # the committed delta
git diff --cached --stat HEAD -- src/                        # plus what is staged
git log --oneline "$prev"..HEAD -- src/
```

Read every hunk under `src/` and write down each change a user could observe:

- a default, a limit, a timeout, an environment variable or a CLI flag;
- signal handling (`SIGHUP`, `SIGTERM`), startup or shutdown order, exit codes;
- a TCP command, an HTTP endpoint, a response shape, an error message or code;
- what is accepted or rejected (validation), what is persisted, a migration;
- log lines that operators match on, and listener or socket options
  (`SO_REUSEPORT`, unix-socket mode and owner);
- performance changes large enough to change capacity planning.

Every item gets an Upgrade notes bullet that says what changed, who is affected, and
what to do. Then check the reverse: every Upgrade notes bullet points to a real hunk.

For example, the 2.9.22 Upgrade notes cover a signal (`SIGHUP` on a TLS server reloads
instead of terminating, with the consequences under `nohup` and in a closed terminal),
a socket option (TLS listeners set `SO_REUSEPORT`, behind an exclusive probe bind) and a
platform edge case (on Linux a connection that races a reload can be reset).

## Number tracing

Every figure in the release post (speedups, counts, latencies, file and test counts)
must come from the changelog or a real measurement; nothing is rounded up or invented.

1. List the numbers: `grep -nE '[0-9]' docs/src/content/docs/blog/bunqueue-vX-Y-Z.md`.
2. For each, find the changelog line that states it:
   `grep -n '<number>' docs/src/content/docs/changelog.md`.
3. A number with no source is removed or measured again natively on macOS (benchmarks
   never run in a container or a Machine), and the measurement goes into the changelog
   first.
4. Keep the table (post line, number, changelog line) in the handoff so the skeptic
   can check it in one pass.

The description and the hero text of the post repeat its headline numbers; trace them
too.
