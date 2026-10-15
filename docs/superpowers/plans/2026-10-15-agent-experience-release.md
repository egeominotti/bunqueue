# Agent Experience 2.9.15 Release Plan

> **For agentic workers:** Use verification-before-completion and the project skeptic gates. Execution records belong in `artifacts/agent-release/`.

**Goal:** Commit and push the approved agent experience changes with the user's explicitly chosen version 2.9.15 and current documentation.

**Architecture:** Keep the implemented MCP and optional agent integration boundaries unchanged. Update package/version documentation, generate the new public API snapshot, validate the exact staged tree and use the existing CI release pipeline.

**Tech Stack:** Bun 1.4.3, TypeScript ESM, TypeDoc, Astro, isolated native OrbStack Machines and Docker sandbox.

**Spec:** `docs/superpowers/specs/2026-10-14-agent-experience-design.md`, plus the user's explicit authorization to bump the version, commit, push and update documentation.

## Constraints

- Preserve all queue core, client, external SDK, dependency and lockfile content.
- Leave model choice with CLI/user configuration.
- Use version 2.9.15 as explicitly requested; refresh the current v2.9 API reference and preserve older version snapshots.
- Stage only the approved feature and release documentation changes.
- Require skeptic PASS before each commit and each push; do not override a failing verdict.
- Main's normal CI creates GitHub/Docker release artifacts for a new version. Root npm publication requires a separate explicit CI dispatch.

## Review Focus

- The new API version must exist in the tracked documentation tree.
- The optional agents entrypoint must appear in generated public documentation.
- Changelog text must describe actual behavior and provider/effect limitations.
- Validation must cover the exact final package version and staged source tree.
- Outgoing commits must contain their corresponding changelog entries and specific English messages.

## Tasks

- [ ] Update root version, current installation/deployment examples and changelog for 2.9.15.
- [ ] Generate and stage the current v2.9 API reference, preserving older version snapshots; verify documentation data and build.
- [ ] Run complete native Ubuntu 24.04 and Debian 13 Machine gates and the official sandbox on the final candidate; review logs and resources.
- [ ] Obtain skeptic PASS on the complete staged diff and create the authorized commit.
- [ ] Verify outgoing commit/changelog/source integrity, obtain a new skeptic PASS and push without force.
- [ ] Preserve validation evidence, remove only owned temporary environments and report commit, version, push and CI state.
