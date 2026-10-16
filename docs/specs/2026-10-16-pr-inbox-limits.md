# PR inbox result limits

## Problem and scope

[Issue 18](https://github.com/AndrewDongminYoo/maintainer_tui/issues/18) tracks counts that appear complete when a bounded PR search returns 100 rows.
Keep the existing three independent searches and their 100-result limit.
Disclose when each fetched bucket reaches that limit without claiming an exact total or definite truncation.

## Contract

- Preserve the existing `attention` arrays and add `attentionLimitReached`, a boolean map for `authored`, `assigned`, and `reviewRequested`.
- Derive each signal from its own fetched row count and the shared search limit.
  Reaching the limit says nothing about whether additional matches exist.
- Include the map in JSON output and cached snapshots.
- Bump the snapshot schema and reject old, missing, malformed, or inconsistent limit metadata through the existing cache validation path.
- At the limit, the main header describes the count as fetched results and marks it with `*`.
  Tabs use the compact `100*` marker; the PR panel explains that the marker means the 100-result limit was reached.
- Preserve independent tab contents, ordering, drafts, cursor reset, keyboard bindings, and repository-list geometry.

## Acceptance

1. Offline GitHub fixtures with 99 and 100 rows exercise each bucket and produce the correct independent signals without live GitHub access.
2. CLI subprocess tests preserve the signals through cache reuse and JSON output; incompatible caches miss normally.
3. Native frame tests inspect below-limit and limit-reached header/tab output for all three buckets and verify navigation still selects the correct contents.
4. At supported narrow review widths, the active bucket's limit explanation is visible and does not overwrite list or footer content.
5. Run `bun test src/github.test.ts src/cli.test.ts src/tui.test.tsx`, the full `bun test` suite, `bun run typecheck`, scoped `trunk check`, and `git diff --check`.
6. Preserve a rendered static preview and obtain operator visual approval before merge.

## Bounds and precedent

No pagination expansion, dependency changes, terminal launching, exact-total query, or unrelated cleanup is included.
The scoped Oracle queries for `snapshot cache`, `PR limits`, `limit reached`, and `cache compatibility` returned `[no precedent found]`.
The existing snapshot validator and isolated GitHub/CLI fixtures govern the implementation.
