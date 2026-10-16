# Configuration-independent CLI information plan

## Direction and ownership

The operator delegated selection and execution of the next bounded issue after PR #23.
Implement [issue #14](https://github.com/AndrewDongminYoo/maintainer_tui/issues/14) according to its [specification](../specs/2026-10-16-config-independent-cli-info.md).
Use branch `fix/config-independent-cli-info` in the main workspace.

Owned paths:

- `src/cli.tsx`: move configuration loading after informational exits.
- `src/cli.test.ts`: isolated subprocess regressions and side-effect guards.
- `docs/specs/2026-10-16-config-independent-cli-info.md`: behavior contract.
- `docs/plans/2026-10-16-config-independent-cli-info.md`: execution and verification plan.

## Steps and success criteria

1. Add subprocess fixtures with malformed configuration and guards for GitHub calls and renderer initialization.
   Verify the guards on normal CLI paths with valid configuration before trusting their absence on informational paths.
2. Run `bun test src/cli.test.ts` before changing production code.
   Observe failures caused by configuration parsing for `--help`, `--h`, and `--version`.
3. Move `loadConfig()` below the informational exits without changing their output or ordering.
   Rerun the focused tests and require informational success plus unchanged failures for configuration-dependent commands.
4. Run `bun test`, `bun run typecheck`, and Trunk formatting and checks with the four explicit owned paths.
   Run `git diff --check` and review the complete candidate inline for option precedence, side effects, and fixture isolation.
5. Commit the scoped change with hooks enabled, push, and open a PR linked to issue #14.
   Observe CI and hosted review against the pushed head within the retained PR loop budget.
6. Request operator merge when checks and applicable review gates pass.
   Do not schedule a version bump, release, branch deletion, or memory write for this new PR without a separate request.
