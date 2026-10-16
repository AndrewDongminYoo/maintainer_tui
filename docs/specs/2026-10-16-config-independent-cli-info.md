# Keep CLI information independent of configuration

## Problem

[Issue #14](https://github.com/AndrewDongminYoo/maintainer_tui/issues/14) reports that malformed configuration prevents help and version output.
Before this fix, `src/cli.tsx` calls `loadConfig()` before handling its informational options.

## Scope

Handle `--help`, `--h`, and `--version` before reading configuration.
Preserve their existing output and precedence, including help taking precedence over version.
Keep configuration-dependent commands on the existing configuration path.

## Acceptance criteria

- Each informational option exits successfully and prints its expected output with an isolated malformed configuration file.
- These paths do not invoke GitHub or initialize the renderer.
- Subprocess test guards detect actual GitHub and renderer calls when the corresponding normal CLI paths execute.
- `--config`, `--json`, and normal startup still reject malformed configuration with the existing path-specific error.
- `bun test src/cli.test.ts`, `bun test`, `bun run typecheck`, scoped Trunk checks, and `git diff --check` pass.
- Hosted CI passes, including the standalone build and smoke test.

## Non-goals and constraints

Do not change configuration validation, cache handling, public APIs, dependencies, terminal layout, or the help text.
Use isolated subprocess environments and temporary files so tests do not read the operator's configuration or contact GitHub.
Remove test fixtures after each test.
No visual approval is needed because the existing informational text and terminal layout remain unchanged.
