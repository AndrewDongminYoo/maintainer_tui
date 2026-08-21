# TUI List Scroll Stability Specification

## Status

Proposed.

## Problem

The repository list stores its focused row in React state and then updates `ScrollBoxRenderable.scrollTop` from a `useEffect`.
When a held arrow key crosses the viewport boundary, the focused-row update and imperative scroll update publish separate OpenTUI frames.
The second frame can arrive while the next repeat key is being processed, producing visible flicker and an unstable scrollbar.

## Goal

Render every keyboard-driven repository-list transition, including viewport scrolling, from one React state transition.
The focused row and the visible viewport must always describe the same repository range in the resulting frame.

## In Scope

- Arrow-key, `j`/`k`, Home, End, PageUp, and PageDown navigation in the repository list.
- A repository-list viewport state containing both the focused index and the first visible index.
- A fixed one-column, text-rendered scrollbar whose thumb is derived from that state.
- Frame-level regression coverage using the existing OpenTUI test renderer.
- Terminal-resize and filter-shrink clamping of the focused index and viewport.

## Out of Scope

- Pull-request overlay navigation, agent-output scrolling, and their existing `scrollbox` instances.
- Repository sorting, filtering semantics, selection behavior, or working-copy status reads.
- Dependency upgrades or changes to OpenTUI itself.
- New mouse or wheel interactions.

## Constraints

- Do not add a dependency.
- Keep the existing functional state-update semantics so repeated keys received before React renders are never dropped.
- Do not use a post-render imperative `scrollTop` update for the repository list.
- Keep the footer and working-copy area at their existing fixed layout height.
- Preserve the existing repository-row columns, copy identifiers, selection markers, and keyboard shortcuts.

## Architecture

Add a focused `src/list-navigation.ts` module that owns the pure list-navigation transition and scrollbar geometry.
Its `ListNavigation` state contains `cursor` and `scrollTop`, and each transition clamps both values against the current item count and viewport row count.

`App` will keep that state in one React `useState` call and render only the visible repository slice in a fixed-height box.
The current repository `scrollbox`, `listRef`, and effect that writes `scrollTop` will be removed from this path.
The new text scrollbar will render a fixed-height track beside the visible rows from `scrollbarThumb`, so it cannot lag one frame behind the selected row.

The initial layout contract is five viewport rows at a 20-row terminal, matching the current test renderer viewport.
The implementation will express the fixed header, footer, and padding row budget in one named constant and will cover that value with a character-frame test.

## Navigation Contract

For an item count `n` and viewport height `v`, valid state satisfies `0 <= cursor < n` and `0 <= scrollTop <= max(0, n - v)` when `n > 0`.
The empty-list state is exactly `{ cursor: 0, scrollTop: 0 }`.

Moving by `delta` first clamps the cursor to the valid item range.
If the next cursor is above the viewport, `scrollTop` becomes the cursor.
If it is below the viewport, `scrollTop` becomes `cursor - v + 1`.
Otherwise, the existing `scrollTop` is retained.

Home targets cursor and scroll position `0`.
End targets the final item and the smallest scroll position that keeps it visible.
Page navigation delegates to the same move transition with the existing half-viewport delta.
Filtering, sorting, archived visibility changes, query changes, and terminal resize normalize the current state before rendering.

## Scrollbar Contract

The scrollbar track has exactly `viewportRows` cells.
For an item count no larger than the viewport, the thumb fills the track and begins at row `0`.
For an overflowing list, the thumb height is `max(1, ceil(viewportRows * viewportRows / itemCount))`.
Its top row is the nearest integer proportional mapping from `scrollTop` over `itemCount - viewportRows` to the available track positions.

The track and thumb use stable one-cell glyphs and never change their allocated width or height while a key is held.

## Acceptance Criteria

1. At a 20-row terminal with a 20-repository fixture, moving down from the last visible row to the next repository publishes one cell-updating renderer frame and shows the next five-row window.
2. Repeated Down and Up inputs preserve every cursor step and keep the focused row within the rendered viewport.
3. The scrollbar has a stable one-column track, a clamped thumb, and the expected location for the first, middle, and last viewport.
4. Home, End, PageUp, PageDown, filtering, and an empty result normalize both cursor and viewport without drawing over the footer.
5. The existing working-copy footer-height regression remains green.
6. `bun test`, `bun run typecheck`, `trunk check`, and `git diff --check` pass.

## Verification Evidence

Use `renderer.keyInput.processParsedKey(parseKeypress(...))` to drive the visible application keyboard path.
Use `captureCharFrame()` for row and scrollbar assertions, and subscribe to OpenTUI frame events only for the explicit one-visual-frame boundary requirement, counting events with a positive `cellsUpdated` value.
Do not infer rendered frames by grepping ANSI-stripped PTY output.

## Risks and Rollback

The fixed viewport row budget must account for every non-list band.
A character-frame test at 20 rows guards the initial layout, and a resize test guards clamping when the budget changes.

The change is isolated to list navigation and rendering.
Rollback consists of restoring the previous repository `scrollbox` rendering path if a verified regression affects documented keyboard navigation.
