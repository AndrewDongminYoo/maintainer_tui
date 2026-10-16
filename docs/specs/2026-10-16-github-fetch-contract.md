# Offline GitHub fetch coverage

## Contract

[Issue #17](https://github.com/AndrewDongminYoo/maintainer_tui/issues/17) expands regression coverage through the real `fetchSnapshot()` entry point.
Preserve production behavior and use a scripted fake `gh` executable without live account access.

Verify these existing behaviors:

- Repository pagination forwards each cursor and accumulates every page in order.
- A transient GraphQL failure receives one retry, including on a later page.
- Two failed GraphQL attempts reject the snapshot with the last diagnostic and do not begin PR searches.
- Authored, assigned, and review-requested searches use their distinct filters and populate the corresponding buckets.
- A failed PR search rejects the snapshot rather than returning partial success.
- Partial GraphQL data remains usable when unreadable vulnerability data also produces errors and a nonzero exit.

## Fixture and acceptance requirements

Run fetches in isolated subprocesses with a temporary executable path.
The fake executable must reject unexpected cursors, duplicate or malformed search arguments, and unplanned requests.
Record calls so retry counts and search coverage are asserted without depending on concurrent search ordering.
Clean temporary files after both success and failure.

Tests must pass on the current production implementation and fail against isolated mutations that break cursor propagation, retries, or bucket filters.
Run `bun test src/github.test.ts`, the full suite, `bun run typecheck`, and scoped Trunk checks.
Keep applicable test documentation accurate in the same PR.

## Boundaries and precedent

Do not change production fetch behavior, retry timing, cache schema, UI, dependencies, or account settings.
Oracle's `raw/sources/.claude/rules/scoped-dependency-overrides.md` requires all pages before claiming complete results.
Its `raw/sources/.claude/skills/responding-to-ai-pr-review/references/workflow.md` distinguishes transient failures from completed paginated observations.
These precedents support multi-page and failure coverage; the project's current code remains the authority for the exact two-attempt GraphQL contract.
