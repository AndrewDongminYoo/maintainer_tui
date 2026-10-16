# Malformed snapshot cache plan

## Scope

Implement [issue #13](https://github.com/AndrewDongminYoo/maintainer_tui/issues/13) under the operator's delegated next-issue PR loop.
Use the [cache contract](../specs/2026-10-16-reject-malformed-snapshot-cache.md) on `fix/reject-malformed-snapshot-cache` in the main workspace.
Keep the requested documentation reconciliation in its own preceding commit.

Owned implementation paths are `src/config.ts`, `src/github.ts`, `src/cli.tsx`, and `src/cli.test.ts`.
The spec and this plan are the supporting documents.

## Steps and verification

1. Extend isolated CLI fixtures to seed cache files and capture the initial snapshot passed to the TUI.
   Use valid caches as a positive control for the capture fixture.
2. Add invalid timestamp and snapshot cases, then run `bun test src/cli.test.ts` before production edits.
   Require failures caused by invalid cache acceptance, not fixture errors.
3. Reject invalid timestamps during cache reads and validate the complete snapshot at CLI consumption.
   Preserve valid cached values and the existing fetch fallback.
4. Run focused CLI tests, `bun test`, `bun run typecheck`, scoped Trunk formatting and checks, and `git diff --check`.
   Review the complete diff for omissions in nested fields, null handling, expiry behavior, and test isolation.
5. Commit the fix separately from documentation reconciliation, push, and open a PR linked to issue #13.
   Observe current-head CI and hosted review before requesting operator merge.

## Non-goals

No release, version bump, visual change, or new PR cleanup or memory publication is scheduled.
