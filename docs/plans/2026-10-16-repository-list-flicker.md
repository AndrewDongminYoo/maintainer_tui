# Repository list flicker plan

## Contract and workspace

Follow the [Flicker investigation contract](../specs/2026-10-16-repository-list-flicker.md) on `fix/repository-list-flicker` in the main workspace.
The operator approved the complete #20–#22 scope, including implementation and the PR lifecycle.
Merge and visual approval remain operator decisions.

## Steps

1. Capture all native frame events around repeated and page navigation through the existing key-input route.
   Verify the fixture can overflow the viewport and exercise delayed working-copy reads.
2. Identify a reproduced failing boundary before changing production code.
   Add the regression to `src/tui.test.tsx`, then make the smallest supported fix in `src/app.tsx` or `src/cli.tsx` only if evidence requires it.
3. Run the real CLI in a bounded terminal session with isolated deterministic data.
   Record motion, terminal version, inputs, and remaining limitations under the visible sibling `pr-loop-reviews/maintainer_tui/flicker-2026-10-16/` directory.
4. Correct affected claims in the existing scroll-stability spec/plan and testing guidance as the evidence warrants.
   Keep historical evidence distinct from the current result.
5. Run `bun test src/tui.test.tsx`, `bun test`, `bun run typecheck`, scoped `trunk check`, and `git diff --check`.
   Review the complete candidate at the repository's required depth.
6. Commit, push, open the scoped PR, and finish hosted review and CI.
   Associate the operator motion review with the actual artifact and reviewed SHA before declaring merge readiness.

## Ownership and bounds

Initial owned paths are this plan, its spec, `src/tui.test.tsx`, and evidence-required changes in `src/app.tsx` or `src/cli.tsx`.
Directly affected documentation includes `CLAUDE.md`, `README.md`, and the August scroll-stability spec and plan.
No dependency changes, account changes, new worktrees, or unrelated UI changes are planned.
If neither renderer nor terminal evidence reproduces a defect, publish the bounded findings and verification coverage without inventing a fix.
