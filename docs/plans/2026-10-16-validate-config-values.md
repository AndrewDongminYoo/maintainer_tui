# Configuration validation plan

## Scope

Implement [issue #12](https://github.com/AndrewDongminYoo/maintainer_tui/issues/12) under the operator's delegated next-issue PR loop.
Follow the [configuration contract](../specs/2026-10-16-validate-config-values.md) in branch `fix/validate-config-values` using the main workspace.

Owned paths:

- `src/config.ts`: runtime validation at the configuration loading boundary.
- `src/cli.test.ts`: reuse isolated subprocess fixtures for invalid values and valid configuration compatibility.
- `docs/specs/2026-10-16-validate-config-values.md`: behavior contract.
- `docs/plans/2026-10-16-validate-config-values.md`: implementation and verification plan.

## Steps and verification

1. Extend subprocess coverage for invalid JSON value shapes, known field types, and enum members.
   Add valid absent, partial, and complete configuration cases to protect defaults and custom applications.
2. Run `bun test src/cli.test.ts` before changing production code.
   Observe accepted invalid values or non-actionable failures instead of the required field-specific diagnostics.
3. Validate parsed values before merging defaults, with no new dependency or public API.
   Keep parse failures and validation failures distinct.
   Rerun the focused tests and verify that startup guards remain untouched on invalid input.
4. Run `bun test`, `bun run typecheck`, scoped Trunk formatting and checks, and `git diff --check`.
   Review the complete candidate in one structured pass for valid configuration compatibility, error paths, and test isolation.
5. Commit the scoped fix with hooks enabled, push, and open a PR linked to issue #12.
   Observe CI and current-head hosted review within the retained budget, then request operator merge.

## Non-goals

No release, version bump, unrelated documentation repair, memory publication, or new PR branch cleanup is scheduled.
