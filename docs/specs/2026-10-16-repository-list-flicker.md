# Repository list flicker investigation

## Scope

Resolve the approved Flicker group: [parent #20](https://github.com/AndrewDongminYoo/maintainer_tui/issues/20), [frame investigation #21](https://github.com/AndrewDongminYoo/maintainer_tui/issues/21), and [real-terminal check #22](https://github.com/AndrewDongminYoo/maintainer_tui/issues/22).
The single navigation state from the August scroll-stability work is already implemented.
Do not assume the remaining symptom has the same cause.

## Acceptance

- Observe every renderer frame during repeated Up and Down input across viewport boundaries and during Home, End, PageUp, and PageDown.
- Check nonempty consecutive list rows, visible focus, a one-column scrollbar, and fixed footer positions in each captured frame.
- Exercise both an uncloned fixture and delayed working-copy results so the fixture can expose asynchronous detail updates.
- Before a production fix, reproduce the defect with a failing regression and identify the responsible boundary.
- If captured frames do not reproduce it, preserve that evidence and report the result in issue #21 instead of making a speculative production change.
- Run the actual CLI in a real terminal with enough repositories to overflow the list; record application/version, input sequence, observed flicker, scrollbar, and footer behavior.
- Preserve an interactive frame playback with its limits for operator visual review, and record the separate real-terminal observation.
  The playback is not a terminal motion recording.
- Run affected tests, the full suite, type checking, scoped Trunk checks, and whitespace checks before opening a PR.

## Constraints

Preserve navigation semantics, repository row content, selection, and footer behavior.
Do not upgrade dependencies or refactor unrelated UI.
Use isolated fixture data for shareable evidence and preserve the operator's configuration and cache.
Do not claim that character-frame captures prove the terminal compositor is flicker-free.
Do not close the parent before both child acceptance records are settled.

## Precedent

Oracle's `raw/sources/.claude/projects/-Users-dongminyu-Development-01-personal-maintainer-tui/memory/opentui-driving-keys-and-row-chrome.md` confirms `processParsedKey(parseKeypress(...))` as the tested route into `useKeyboard`.
The same project's `memory/MEMORY.md` records a PTY grep false negative and a `mockInput` path that did not reach the hook.
Use completed character frames for automated assertions and actual terminal motion as separate evidence.
No direct precedent identified the remaining flicker cause.
