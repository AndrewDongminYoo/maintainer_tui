# Repository list flicker evidence

## Candidate and scope

Production baseline: `45c409d255f41cbe9dff8b08295d80914587416f`.
This investigation covers issues #20, #21, and #22 using Bun 1.4.3 and the installed OpenTUI 0.5.3 renderer.
No production behavior was changed because the reported flicker did not reproduce in the captured character buffers.
The operator also reported no flicker in the isolated real-terminal check described below; this does not establish the result for every terminal or live repository dataset.

## Every-frame observation

The diagnostic mounted the real App through OpenTUI's test renderer and listened to every native `frame` event after initial setup.
It captured 580 completed character buffers across six scenarios with 50 repositories each.
Each scenario sent 35 Down inputs, 35 Up inputs, then End, PageUp, PageUp, PageDown, Home, PageDown, End, and Home.
Inputs used `processParsedKey(parseKeypress(...))` at the intervals below without forcing a flush after each key.
The cloned fixture used exact matching origin identities and delayed working-copy results by 25 ms.

| Fixture  | Dimensions | Input interval | Frames | Working-copy reads |
| -------- | ---------- | -------------- | ------ | ------------------ |
| Uncloned | 100 × 20   | 16 ms          | 80     | 0                  |
| Uncloned | 100 × 40   | 32 ms          | 105    | 0                  |
| Uncloned | 40 × 20    | 16 ms          | 81     | 0                  |
| Cloned   | 100 × 20   | 16 ms          | 81     | 79                 |
| Cloned   | 100 × 40   | 32 ms          | 152    | 79                 |
| Cloned   | 40 × 20    | 16 ms          | 81     | 79                 |

Every captured frame contained the full consecutive repository window, exactly one focused row, a matching detail repository, a complete scrollbar in a stable column, and the footer at its expected row.
The frame analyzer rejected an intentionally empty frame before accepting the real captures.
The narrow fixture truncates header text, so the presence of the full word `maintainer` was not used as its blank-frame detector.

## Automated regression coverage

The two new `tui.test.tsx` cases inspect every emitted frame while moving across both list boundaries and using Home, End, PageUp, and PageDown.
They assert each resulting cursor position and a batched ten-key movement as positive controls for keyboard delivery.
The cloned case resolves deferred working-copy reads and proves that at least one captured frame contains the branch result.
Both cases pass on unchanged production code.
An isolated test mutation inserts empty intermediate frames while preserving the valid final capture; both cases must reject it.
This checks the observer's sensitivity and is not evidence that production emitted an empty frame.

## Real-terminal verification

Status: the operator reported no visible flicker on 2026-10-16 when running the provided `terminal-check.ts` launcher.
The completed session recorded WarpTerminal `v0.2026.10.07.08.29.stable_00`, `xterm-256color`, Darwin 27.0.0, a 155 × 70 terminal, and exit code 0.
The recorded session ran from `2026-10-16T01:46:47.093Z` to `2026-10-16T01:46:56.381Z`.
The operator subsequently confirmed held Down and Up across viewport boundaries, Home, End, PageUp, and PageDown, with no flicker, a stable scrollbar column, and a fixed footer.
The computer-use tool refused access to `dev.warp.Warp-Stable` for safety reasons.
No alternate desktop automation was used to bypass that restriction.
An isolated launcher prepares 200 synthetic repositories in temporary XDG configuration and cache directories and runs the actual `src/cli.tsx`.
Its live GitHub executable is blocked, and its temporary data is removed after exit.
The launcher passed a PTY startup-and-quit check with exit code 0; that proves launch and cleanup, not desktop rendering.

This completes the manual acceptance for issue #22 in the recorded terminal and synthetic fixture.
Captured character-buffer playback is available as local review evidence, but it cannot substitute for a terminal observation or motion recording.
No desktop motion recording was captured.
Issue #21 follows its explicit no-reproduction outcome; issue #22 has the operator observation above.
The parent can close with its children after this evidence and regression coverage are merged.
