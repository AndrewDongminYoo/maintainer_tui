# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun test                          # full suite (src/core.test.ts)
bun test -t "activity sort"       # one test by name
bun run typecheck                 # tsc --noEmit
bun run start                     # TUI from source
bun run build                     # single binary → dist/maintainer
trunk fmt && trunk check          # pre-commit gate (prettier, cspell, markdownlint, scanners)
```

A passing `bun test` run prints `compilation error: Expected end of line…` — that is the negative case of the `osacompile` test, not a failure.

`README.md` owns usage, keybindings, the config schema, and per-app launch behaviour; don't restate them here.

## Architecture

A Bun + OpenTUI TUI over `gh`. Four data modules, one React view.

- `src/cli.tsx` — entry point. Handles `--json`, `--config`, `--help` and the non-TTY guard, then creates the renderer and mounts `App`.
- `src/github.ts` — one paginated `gh api graphql` query for every repo the viewer can push to, plus two `gh search prs` calls for the header counts. Owns `sortRepos`/`filterRepos`/`needsRelease`.
- `src/local.ts` — maps GitHub repos to on-disk checkouts, clones what's missing, and builds the argv that opens a repo in the configured app.
- `src/agent.ts` — spawns `claude`/`codex` in a checkout with a triage prompt built from the snapshot's own findings.
- `src/config.ts` — config and the snapshot cache (`~/.cache/maintainer-tui/repos.json`; TTL lives in `cli.tsx`, 10 min).
- `src/app.tsx` — all TUI state and key handling in one component. Overlays (`help`, `agent`) are early returns, not layers.

`Snapshot` is the unit of caching and the unit of state: fetch once, then sort/filter/derive everything else from it in memory.

### Invariants worth knowing before editing

- **`gql()` parses stdout even when `gh` exits non-zero.** GitHub returns a partial result plus a top-level `errors` array for any repo where the token can't read `vulnerabilityAlerts`; treating that as failure loses the whole listing.
- **Clone detection reads `.git/config` directly** rather than `git -C <dir> remote get-url origin`, which walks upward and makes every plain subdirectory of a git root look like a checkout. `scanRoots` stores two keys per clone — `owner/name` from the remote, and the bare directory name as a fallback for repos renamed on GitHub.
- **`launchArgv` is pure and `launchAll` executes it.** Keep new app strategies in `launchArgv` so they stay testable.
- **AppleScript paths cross two escaping layers** (`shq` for the shell, `asq` for the AppleScript string literal). `core.test.ts` asserts the source form and compiles the result with `osacompile`, which parses without running.
- **`runAgent` spawns rather than awaits `execFile`** so closing the overlay can actually kill a minutes-long turn.
- **`createCliRenderer()` takes exclusive ownership of stdin and stdout**, so every early exit in `cli.tsx` has to return before it. Importing `@opentui/react` is side-effect free; calling the renderer is not.

## Conventions

- Imports: `@/*` for vendored UI (`src/components`, `src/hooks`, `src/lib`, `src/providers`); relative paths **with the `.ts`/`.tsx` extension** for app modules — `verbatimModuleSyntax` and `allowImportingTsExtensions` are on, so `import type` is mandatory for types.
- Vendored termcn components come from the `@termcn/opentui/*` namespace (registry in `components.json`) — never `@termcn/ink/*`. Colors come from `useTheme()`; don't hardcode ANSI. Two known registry defects are patched locally and will come back if a component is re-added: `divider` uses per-side border booleans OpenTUI does not have, and `use-animation` imports Ink for what is one env read.
- `tsconfig.json` sets `jsxImportSource` to `@opentui/react`; without it `<text>` resolves to the DOM lib's SVG element.
- Comments explain _why_ a non-obvious choice was made, and cite the observed behaviour that forced it. Match that register — don't narrate what the code already says.
- Conventional commits, scoped by module (`fix(github):`, `feat(local):`).
- New words go in `cspell-words.txt` or an inline `// cspell:words` comment.

## Testing

`core.test.ts` covers pure logic, with real `git init` fixtures in `tmpdir` for clone detection; the `osacompile` test is `skipIf` non-darwin. `tui.test.tsx` renders the real `App` through OpenTUI's test renderer and asserts `captureCharFrame()` — never a pty byte capture, which is a cell-by-cell diff that no longer contains a label whose second half changed. It drives no keys: `mockInput` emits on `renderer.stdin` and the `useKeyboard` subscription does not see it, so a keypress assertion there would pass vacuously.

Nothing mocks `gh` — the network layer is exercised by running `maintainer --json`, which is also the only way to reach it without a TTY.
