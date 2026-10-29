# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun test                          # full suite: logic, GitHub fixtures, CLI, TUI, agents
bun test -t "activity sort"       # one test by name
bun run typecheck                 # tsc --noEmit
bun run start                     # TUI from source
bun run build                     # single binary → dist/maintainer
trunk check --all --no-fix --jobs=2 # full configured quality gate
python3 -B .trunk/configs/tests/test_trufflehog_to_sarif.py # offline reader regressions
```

Trunk manages Node `22.23.4` because CSpell `10.4.0` declares Node `>=22.18.0`.
This managed runtime is separate from the application's Bun runtime.
CSpell reads `cspell.json` and the project word list; only the immutable vendored OpenTUI copies are excluded from spelling checks.
Owned code, documents, configuration and word lists remain checked.
The local filesystem secret reader retains decoded findings without literal source positions and runs in CI through its exact standard-library test file.

A passing `bun test` run prints `compilation error: Expected end of line…` — that is the negative case of the `osacompile` test, not a failure.

`README.md` owns usage, keybindings, the config schema, and per-app launch behaviour; don't restate them here.

## Architecture

A Bun + OpenTUI TUI over `gh`. Four data modules, one React view.

- `src/cli.tsx` — entry point. Handles `--json`, `--config`, `--help` and the non-TTY guard, then creates the renderer and mounts `App`.
- `src/github.ts` — one paginated `gh api graphql` query for every repo the viewer can push to, plus three `gh search prs` calls for authored, assigned, and review-requested PRs.
  Owns `sortRepos`/`filterRepos`/`needsRelease`.
- `src/local.ts` — maps GitHub repos to on-disk checkouts, clones what's missing, and builds the argv that opens a repo in the configured app.
- `src/agent.ts` — spawns `claude`/`codex` in a checkout with a triage prompt built from the snapshot's own findings.
- `src/config.ts` — config and the snapshot cache (`~/.cache/maintainer-tui/repos.json`; TTL lives in `cli.tsx`, 10 min).
- `src/app.tsx` — all TUI state and key handling in one component. Overlays (`help`, `agent`) are early returns, not layers.

`Snapshot` is the unit of caching and the unit of state: fetch once, then sort/filter/derive everything else from it in memory.

### Invariants worth knowing before editing

- **`gql()` parses stdout even when `gh` exits non-zero.** GitHub returns a partial result plus a top-level `errors` array for any repo where the token can't read `vulnerabilityAlerts`; treating that as failure loses the whole listing.
- **Clone detection reads Git metadata directly** rather than `git -C <dir> remote get-url origin`, which walks upward and makes every plain subdirectory of a Git root look like a checkout. `scanRoots` records only the canonical `owner/name` from the remote. Linked worktrees follow `commondir` to the shared configuration. A renamed GitHub repository requires its local `origin` URL to be updated.
- **`launchArgv` is pure and `launchAll` executes it.** Keep new app strategies in `launchArgv` so they stay testable.
- **AppleScript paths cross two escaping layers** (`shq` for the shell, `asq` for the AppleScript string literal). `core.test.ts` asserts the source form and compiles the result with `osacompile`, which parses without running.
- **`runAgent` spawns rather than awaits `execFile`** so closing the overlay can actually kill a minutes-long turn.
- **`createCliRenderer()` takes exclusive ownership of stdin and stdout**, so every early exit in `cli.tsx` has to return before it. Importing `@opentui/react` is side-effect free; calling the renderer is not.
- **OpenTUI draws an overflowing child over its neighbour instead of clipping it**, so one row of overrun corrupts everything below rather than truncating. Only the list carries `flexGrow`; every other band is `flexShrink={0}`, and the row's fixed columns are too.
- **Key presses arrive faster than React re-renders.** Anything derived from the previous value has to go through the functional updater — a held key put five presses in one tick against the same captured index and moved the cursor two rows. `stepper()` is the shared answer; build new cursors from it rather than off a captured index. A _mode_ flag has the same problem and no functional-updater escape — the handler must branch on a ref (`searchingRef`), or the rest of a pasted `/name` runs as commands.

## Conventions

- Imports: `@/*` for vendored UI (`src/components`, `src/hooks`, `src/lib`, `src/providers`); relative paths **with the `.ts`/`.tsx` extension** for app modules — `verbatimModuleSyntax` and `allowImportingTsExtensions` are on, so `import type` is mandatory for types.
- Vendored termcn components come from the `@termcn/opentui/*` namespace (registry in `components.json`) — never `@termcn/ink/*`. Colors come from `useTheme()`; don't hardcode ANSI. Known registry defects are patched locally and come back if a component is re-added: `divider` uses per-side border booleans OpenTUI does not have, `use-animation` imports Ink for what is one env read, and `keyboard-shortcuts` and `alert` omit `flexDirection` on a box they mean to be a row — Ink's default, not OpenTUI's, which stacks the contents instead. Check any newly added component for that last one; it type-checks and merely looks wrong.
- `tsconfig.json` sets `jsxImportSource` to `@opentui/react`; without it `<text>` resolves to the DOM lib's SVG element.
- Comments explain _why_ a non-obvious choice was made, and cite the observed behaviour that forced it. Match that register — don't narrate what the code already says.
- Conventional commits, scoped by module (`fix(github):`, `feat(local):`).
- New words go in `cspell-words.txt` or an inline `// cspell:words` comment.

## Testing

`core.test.ts` covers pure logic, with real `git init` fixtures in `tmpdir` for clone detection; the `osacompile` test is `skipIf` non-darwin. Anything the frame test cannot reach is pushed into a pure function there or in `app.tsx` (`tags`, `prQueue`, `withoutOwner`) so it gets covered somewhere. `tui.test.tsx` renders the real `App` through OpenTUI's test renderer and asserts `captureCharFrame()` — never a pty byte capture, which is a cell-by-cell diff that no longer contains a label whose second half changed. `mockInput` does not reach `useKeyboard`; a test that needs a visible key path calls `renderer.keyInput.processParsedKey` directly.

`github.test.ts` exercises `fetchSnapshot()` in isolated subprocesses with a scripted fake `gh` executable that checks and records arguments.
It covers pagination, GraphQL retries and partial data, independent PR buckets, and search failures without live GitHub access.
PR limit tests use 99- and 100-result fixtures per bucket; cached snapshots validate the limit flags against their fetched arrays before JSON or TUI startup consumes them.
The scrolling cases in `tui.test.tsx` inspect every emitted frame, including repository-specific delayed working-copy updates and native scheduled input outside `React.act`; final-frame assertions and effect batching can hide intermediate mismatches.
Character buffers do not verify a desktop terminal's rendering or flicker; record that observation separately.
`cli.test.ts` uses a fake `gh` executable and a renderer guard to verify configuration handling and startup side effects in isolated subprocesses.
Run `maintainer --json --refresh` to exercise the live data layer without a TTY.

## Offline scanner resource boundary

Run `python3 -B .trunk/configs/tests/test_trufflehog_to_sarif.py` for the 17 command-line reader regressions.
Source context is limited to 1 MiB plus a sentinel byte per read and at most eight cached files.
Oversized, unreadable, binary or decoded-only findings retain file-level diagnostics instead of disappearing.
Native Trunk paths and Unicode code-point columns are preserved.
The large-source and multi-file regressions measure traced Python allocations on ASCII fixtures; they do not establish a universal process RSS or I/O timeout bound.
Malformed scanner input fails the gate, and candidate credentials are never verified with a provider.
