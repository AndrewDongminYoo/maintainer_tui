# TUI List Scroll Stability Implementation Plan

**Goal:** Remove the repository-list flicker caused by independently scheduled cursor and `scrollTop` updates while keeping existing keyboard navigation and row content intact.

**Architecture:** Store the repository cursor and viewport offset together in a pure `ListNavigation` state transition, then render only that state’s visible rows in a fixed-height list box with a derived text scrollbar.
This removes the repository list’s post-render imperative `ScrollBoxRenderable.scrollTop` write.

**Tech Stack:** TypeScript, React 19, `@opentui/react`, Bun test runner.

**Spec:** `docs/specs/2026-08-21-tui-list-scroll-stability.md`.

## Global Constraints

- Do not add dependencies.
- Keep repeated-key updates functional.
- Do not change overlay scrollboxes or working-copy footer behavior.
- Drive keyboard integration tests through `renderer.keyInput.processParsedKey(parseKeypress(...))`.
- Assert screen contents with `captureCharFrame()`.

## File Map

| File                                                 | Responsibility                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/list-navigation.ts`                             | Pure cursor, viewport, and scrollbar geometry transitions.                                        |
| `src/list-navigation.test.ts`                        | Direct boundary tests for navigation normalization and scrollbar geometry.                        |
| `src/app.tsx`                                        | Replace the repository `scrollbox` path with a fixed viewport driven by `ListNavigation`.         |
| `src/tui.test.tsx`                                   | Exercise real keyboard input, captured frames, and renderer-frame counts for the integrated list. |
| `docs/specs/2026-08-21-tui-list-scroll-stability.md` | Product and technical acceptance criteria.                                                        |

## Tasks

### Task 1: Define and test pure repository-list navigation

**Files:**

- Create: `src/list-navigation.ts`.
- Create: `src/list-navigation.test.ts`.

- [ ] Write failing tests for `normalizeListNavigation`, `moveListNavigation`, `setListCursor`, and `scrollbarThumb`.
      Cover an empty list, a list shorter than the viewport, a 20-item list with a 5-row viewport, repeated positive and negative moves, Home, End, and a filter shrink from 20 items to 2 items.

- [ ] Run `bun test src/list-navigation.test.ts` and confirm the test fails because the module does not exist.

- [ ] Implement the exported interfaces `ListNavigation` and `ScrollbarThumb` plus the four pure functions.
      `moveListNavigation` must derive the next cursor and scroll offset in one return value.
      `setListCursor` must use the same normalization path as Home and End.
      `scrollbarThumb` must return a clamped `top` and `height` without depending on React or OpenTUI.

- [ ] Run `bun test src/list-navigation.test.ts` and confirm every literal state and thumb expectation passes.

### Task 2: Render the repository list from one navigation state

**Files:**

- Modify: `src/app.tsx` around the list state, `useTerminalDimensions`, navigation commands, and the repository-list JSX.
- Modify: `src/list-navigation.ts` only if Task 2 reveals a missing pure transition covered by a new failing unit test.

- [ ] Add failing frame tests in `src/tui.test.tsx` for the 20-item, 20-row fixture.
      The tests must assert that crossing the fifth-row boundary shows repositories `repo-01` through `repo-05`, that the selected marker is on `repo-05`, and that the input produces one cell-updating renderer frame.

- [ ] Replace the standalone `cursor` state with `ListNavigation` state.
      Keep updates functional by calling `setListNavigation(previous => moveListNavigation(previous, delta, visible.length, viewportRows))` for arrows, `j`/`k`, and page movement.
      Use `setListCursor` for Home, End, query edits, filter changes, sort changes, and archived visibility changes.

- [ ] Derive `viewportRows` from terminal height and one named non-list row budget.
      Render `visible.slice(scrollTop, scrollTop + viewportRows)` inside a box with that exact height.
      Keep each row’s original absolute index when deciding focus, copy identifiers, and selection markers.

- [ ] Render a fixed-width text scrollbar next to the sliced rows from `scrollbarThumb`.
      Use one-cell track and thumb glyphs, reserve exactly one column, and ensure the thumb has full-track height when the whole list fits.

- [ ] Remove the repository `ScrollBoxRenderable` import, `listRef`, and the effect that assigns `listRef.current.scrollTop`.
      Leave `modalRef` and all overlay `scrollbox` behavior unchanged.

- [ ] Run the focused TUI tests and confirm the new boundary test passes before moving on.

### Task 3: Cover resize, filters, and held-key regressions

**Files:**

- Modify: `src/list-navigation.test.ts`.
- Modify: `src/tui.test.tsx`.

- [ ] Add pure tests that reduce viewport height, reduce item count, and normalize a cursor that was previously at the end of the list.
      Assert the resulting cursor remains visible and `scrollTop` stays within `0..itemCount - viewportRows`.

- [ ] Add integrated tests that send several Down and Up sequences through `processParsedKey` before a flush.
      Assert the functional updater preserves every movement and the captured frame keeps the focused row visible.

- [ ] Add a character-frame assertion that the footer divider and working-copy placeholder remain below the fixed list viewport at a 20-row terminal.
      Retain the existing asynchronous working-copy-height test without modifying its intended behavior.

- [ ] Run `bun test src/tui.test.tsx` and `bun test src/list-navigation.test.ts`.

### Task 4: Verify the complete change and inspect the terminal behavior

**Files:**

- Verify only: `src/app.tsx`, `src/list-navigation.ts`, `src/list-navigation.test.ts`, and `src/tui.test.tsx`.

- [ ] Run `bun test` and require zero failures.

- [ ] Run `bun run typecheck` and require a zero exit code.

- [ ] Run `git diff --check` and inspect the diff to confirm it changes only the repository-list navigation and its tests.

- [ ] Run `bun run src/cli.tsx` in a terminal with enough repositories to overflow the list.
      Hold Up and Down across the viewport boundary, then use Home, End, PageUp, and PageDown.
      Confirm there is no visible whole-screen flicker, the scrollbar moves as one stable column, and the footer stays fixed.

## Requirement Coverage

| Specification requirement     | Plan task                      |
| ----------------------------- | ------------------------------ |
| One-frame boundary transition | Task 2 frame-count regression. |
| Held-key correctness          | Tasks 1 and 3.                 |
| Stable scrollbar geometry     | Tasks 1 and 2.                 |
| Filter and resize clamping    | Task 3.                        |
| Fixed footer preservation     | Task 3.                        |
| Full verification             | Task 4.                        |

## Execution Boundary

This plan does not include committing, pushing, or creating a pull request.
Those actions require a separate request after the implementation and verification are complete.
