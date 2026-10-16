# PR inbox limit plan

## Contract and workspace

Implement [the result-limit contract](../specs/2026-10-16-pr-inbox-limits.md) for issue 18 on `feat/pr-inbox-limits` in the main workspace.
The operator authorized selecting and delivering the next issue through `pr-loop` after PR 28 follow-through.
Merge and visual approval remain operator decisions.

## Steps

1. Add failing fixtures in `src/github.test.ts`, `src/cli.test.ts`, and `src/tui.test.tsx` for per-bucket limit disclosure, cache compatibility, JSON output, and native frames.
   Failures must observe missing signals or misleading output, not syntax or fixture errors.
2. Update `src/github.ts` with the shared search limit, snapshot map, schema revision, and validation.
   Preserve existing PR arrays and search semantics.
3. Pass the map through `src/cli.tsx` JSON output and render compact markers with fetched-result wording in `src/app.tsx`.
   Update typed fixture defaults in `src/core.test.ts` and `scripts/standalone-smoke.ts` where the new contract requires it.
4. Update affected README and existing testing guidance; inspect `CLAUDE.md` and any existing `AGENTS.md` for changed claims.
   Do not create missing instruction files or repair unrelated post-merge drift.
5. Run the targeted suites, full suite, type checking, explicit-path Trunk checks, and whitespace checks.
   Capture native rendered frames for static operator review, including narrow and all-buckets-at-limit cases.
6. Review the complete candidate at its actual scope, repair supported findings, commit by concern, push, and complete hosted review and CI.
   Bind visual approval and all review gates to the current candidate before requesting operator merge.

## Constraints

Do not change dependencies or introduce another cache layer.
Use the existing invalid-cache fallback instead of migrating old snapshots in place.
Keep fixture commands isolated from live GitHub and user configuration.
