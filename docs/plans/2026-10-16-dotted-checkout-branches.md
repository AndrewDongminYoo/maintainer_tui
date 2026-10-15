# Dotted checkout branch implementation plan

## Contract

Implement [issue #15](https://github.com/AndrewDongminYoo/maintainer_tui/issues/15) according to the [specification](../specs/2026-10-16-dotted-checkout-branches.md).
Use the current workspace and proposed branch `fix/dotted-checkout-branches` after direction approval.
The operator approved this direction on 2026-10-16.

## Owned paths

- `src/local.ts`: branch extraction only.
- `src/core.test.ts`: real Git regression fixtures and assertions.
- `docs/specs/2026-10-16-dotted-checkout-branches.md`: bounded behavior contract.
- `docs/plans/2026-10-16-dotted-checkout-branches.md`: execution and verification plan.

## Steps and success criteria

1. Recheck workspace and branch state, then create the task branch from verified `main`.
   Verify with `git status --short` and the current branch and HEAD.
2. Add real Git fixtures for unborn and committed dotted branches, plus an upstream fixture with commits on both sides.
   Verify with `bun test src/core.test.ts -t checkoutState` and observe failures caused by truncated names.
   Use fixture-local Git identity and local refs only, and remove new temporary fixtures after each test.
3. Change branch extraction to stop at the upstream delimiter or whitespace while allowing individual periods.
   Verify complete names, tracking flags, and exact ahead/behind counts with the same focused command.
4. Run `bun test src/core.test.ts`, `bun test`, and `bun run typecheck`.
   These checks exercise the public function through real Git, the existing suite, and TypeScript compatibility respectively.
   Install existing dependencies with `bun install --frozen-lockfile` if required.
5. Format only owned paths, then run scoped Trunk checks and `git diff --check`.
   Review the complete candidate inline for upstream parsing, unborn headers, detached HEAD compatibility, and fixture isolation.
6. Show the semantic commit plan, stage explicit paths, and commit with hooks enabled.
   Push the task branch and create a PR linked to issue #15.
7. Observe current-head CI and hosted review within the PR loop budget.
   Inspect all review threads and resolve only findings with an evidenced disposition.
   Request operator merge after the readiness gates pass.

## Boundaries

The loop authorizes scoped implementation, commits, pushes, PR writes, and review replies.
Merge, branch deletion, and memory recording have not been requested.
No separate worktree is needed for the verified clean workspace.
Hosted CI additionally checks the standalone build and smoke test.
