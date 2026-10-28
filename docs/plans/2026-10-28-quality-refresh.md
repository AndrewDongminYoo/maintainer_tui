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

## Reader Follow-up Verification

1. Verify byte identity with the independently reviewed shared reader/test and run all ten standard-library regressions.
2. Reproduce old-reader decoded loss and actual configured encoded/literal failures plus clean success.
3. Run the full no-fix Trunk gate and observed spelling controls while keeping owned source, documents, configuration and word lists checked.
4. Verify exact CI-step addition and retain prior application gates only after protected inputs compare equal.

## Verified CSpell Scope Correction

Node `22.16.0` refuses to run CSpell `10.4.0`, so the original quiet result did not establish a clean spelling baseline.
The supported managed runtime exposes existing vocabulary and vendored documentation findings.
Bundled dictionaries were applied before local vocabulary triage.
Exclude only the verified immutable OpenTUI copies at `.agents/skills/opentui/**` and `.claude/skills/opentui/**` from CSpell.
The actual reporter file sets must lose exactly those vendor copies and no owned files.
Keep source, documentation, configuration and dictionary canaries blocking, and verify an excluded vendor spelling canary does not weaken secret detection.
Register observed project/API terms in the existing dictionary.
Keep deliberate clipped-display assertions and a historical temporary-path fragment in exact file-local directives.
Do not rewrite vendored content, runtime logic or historical narrative.
