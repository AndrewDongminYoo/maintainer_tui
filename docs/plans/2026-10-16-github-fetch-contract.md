# GitHub fetch coverage plan

## Scope

Implement [issue #17](https://github.com/AndrewDongminYoo/maintainer_tui/issues/17) in the main workspace on `test/github-fetch-contract`.
Follow the [fetch contract](../specs/2026-10-16-github-fetch-contract.md).
Owned paths are `src/github.test.ts`, the directly affected test guidance in `CLAUDE.md`, and this spec and plan.
Preserve the prior PR completion receipt as a local artifact outside the implementation commit.

## Steps and verification

1. Replace the single-response fake with an isolated subprocess fixture that records and checks actual `gh` arguments.
   Preserve the existing partial-data regression.
2. Cover multi-page accumulation, successful retry, exhausted retry, populated independent PR buckets, and a failed search.
   Assert diagnostics, request counts, and returned contents.
3. Run the focused suite on current production code.
   Run targeted cases against temporary copies with broken cursor propagation, retry count, and bucket filters and require the expected failures.
   Do not edit tracked production files for these negative controls.
4. Inspect `CLAUDE.md`, `README.md`, and the affected spec against the candidate.
   Update test guidance in this PR, then run the full suite, type checking, scoped Trunk checks, and whitespace checks.
5. Review the complete candidate for fixture blind spots, subprocess isolation, concurrent search ordering, and cleanup.
   Commit, push, open the PR, and observe CI and current-head hosted review before requesting operator merge.

## Non-goals

No production refactor, new error policy, release, visual change, or next-PR cleanup or recording is scheduled.
