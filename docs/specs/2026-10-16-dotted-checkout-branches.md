# Preserve dotted checkout branch names

## Problem

[Issue #15](https://github.com/AndrewDongminYoo/maintainer_tui/issues/15) reports that `checkoutState` truncates `release/1.2` to `release/1`.
The branch capture in `src/local.ts` excludes every period, although the upstream separator is three consecutive periods.
The existing real Git test uses `trunk` and does not exercise this case.

## Scope

Preserve the complete branch name in Git porcelain status headers for unborn branches, committed branches without an upstream, and branches with an upstream.
Keep tracking, ahead/behind counts, and file status counts unchanged.
Use real temporary Git repositories to verify the public `checkoutState` function.

## Non-goals

Do not change the public API, terminal layout, clipboard logic, Git status format, dependency versions, or unrelated configuration and cache handling.
Do not fetch from or push to a remote as part of a test fixture.

## Acceptance criteria

- An unborn `release/1.2` branch returns its complete name, `tracked: false`, and zero ahead/behind counts.
- A committed `release/1.2` branch without an upstream returns its complete name and remains untracked.
- A dotted branch with a dotted upstream retains its own name and reports `tracked: true`.
- A fixture with different commits on each side reports the expected nonzero ahead and behind counts.
- Existing branch and dirty-file assertions still pass.
- `bun test src/core.test.ts`, `bun test`, and `bun run typecheck` pass.
- Scoped Trunk checks and `git diff --check` pass before publication.

## Constraints and review

Keep the production change local to branch extraction in `src/local.ts`.
Add focused coverage in `src/core.test.ts` without introducing dependencies or a parser abstraction.
The principal regression risk is consuming the upstream name as part of the local branch name.
Observe the new tests fail on branch truncation before applying the fix.
This is a data correctness fix with no layout or styling change, so separate visual approval is not applicable to the proposed scope.
