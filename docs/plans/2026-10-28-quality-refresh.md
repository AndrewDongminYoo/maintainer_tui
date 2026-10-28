# Quality Tooling Refresh Plan

## Work

1. Verify repository identity, instructions, current changes and Oracle precedent.
2. Refresh compatible dependency and linter versions with existing package managers.
3. Run the declared local gates and `trunk check --all --no-fix`.
4. Reconcile affected knowledge and review the scoped candidate.
5. Commit locally and prepare visible evidence before requesting publication approval.

## Declared Gates

- `bun install --frozen-lockfile`
- `bun test`
- `bun run typecheck`
- `bun run build`
- `bun run smoke:standalone`
- Direct OSV scan of `bun.lock` with the configured scanner version.
- `trunk check --all --no-fix`

Verify the installed required peer graph against package metadata separately from the test suite.
Use an incompatible TypeScript version in memory as a negative control before trusting that validator.
Run standalone and full Trunk gates sequentially within the shared machine's available gate slot.
