# Plan

Resolve the five audit findings in risk order with regression tests before production changes.
Keep each fix local to its current module and reuse the existing Bun, OpenTUI, Git fixture, and CI conventions.

## Scope

- In: Repository identity, vulnerability-state fidelity, agent lifecycle ownership, refresh and clone coordination, standalone release verification, and their automated tests.
- Out: New dependencies, unrelated UI changes, live GitHub mutations, Homebrew publication, commits, pushes, and releases.

## Action items

- [x] Add real Git fixtures for cross-owner name collisions, linked worktrees, and distinct clone destinations in `src/core.test.ts`.
- [x] Update `src/local.ts` so local resolution uses canonical identity, linked worktrees follow `commondir`, and clone destinations include the owner.
- [x] Add unavailable-alert tests, then preserve `null` through `src/github.ts`, JSON output, filters, and the TUI marker.
- [x] Add controlled agent-run tests, then protect triage completion with run ownership and terminate the spawned process tree on cancel or timeout.
- [x] Add reverse-completion and repeated-key tests, then enforce latest-wins refresh behavior and single-flight clone behavior in `src/app.tsx`.
- [x] Make the standalone target explicit and add a clean-directory renderer smoke path to the CI workflow.
- [x] Run focused tests after each change, then run `bun test`, `bun run typecheck`, `bun run build`, `trunk check --all --no-progress`, and `git diff --check`.
- [x] Review the final diff against this finding ledger and record any acceptance criterion that remains partial.

## Open questions

- None.
