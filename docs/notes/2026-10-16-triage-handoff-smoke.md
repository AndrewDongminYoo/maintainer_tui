# macOS triage handoff smoke record

## Status

Completed runtime record for [issue 19](https://github.com/AndrewDongminYoo/maintainer_tui/issues/19), observed on 2026-10-16.
All four application-and-handoff combinations passed the operator-observed cwd and prompt checks across two runs.
The second run completed the missing fresh iTerm and both Terminal cases and captured their actual launch arguments.
The earlier iTerm reply-seeded command is reconstructed from unchanged production helpers and its saved prompt path; it is not a historical invocation capture.
No production code changed for this verification task.

## Environment and fixture

- Source revision: `86ddd001fbfed8d93846a6e35068ed7d6cb35ca5`.
- macOS: 27.0.1, build 26A434.
- iTerm: 3.7.5, installed under the user's Applications directory.
- Terminal: 2.15.
- Configured agent: Claude Code 2.1.301.
- Initial operator run: `run-2026-10-16T08-33-11.353Z`.
- Remaining-case operator run: `run-2026-10-16T10-13-26.375Z`.
- Initial runner source SHA-256: `64efe61ed672bd8a44be806cf8905ef7c7748a709b590cadf5eb8d0af3ecd9ef`.
- Remaining runner source SHA-256: `ab33e7cc7dc27531139d5073a4f12f8fd194b112e9c66af73cf1d328b8ac3cb9`.
- Command-capture shim SHA-256: `853edfd94ef45c8e9abc39ec1259efd1f67ab461a304a319479da7cd0b92af55`.

The expected checkout contains both spaces and an apostrophe:

```plaintext
/Users/dongminyu/Development/01_personal/pr-loop-reviews/maintainer_tui/triage-handoff-2026-10-16/fixture repos/Andrew's checkout
```

The harness supplies a deterministic multiline triage reply through the existing `startAgent` boundary, then drives the real `App` keyboard handler and production launch implementation.
The preceding one-shot triage call and GitHub data are controlled fixtures.
The destination is the real installed Claude Code application.

## Observed cases

| Application | Handoff            | Working directory       | Opening prompt               | Result                                               |
| ----------- | ------------------ | ----------------------- | ---------------------------- | ---------------------------------------------------- |
| iTerm       | Fresh (`o`)        | Exact expected checkout | Empty new conversation       | Operator-reported pass, second run                   |
| iTerm       | Reply-seeded (`O`) | Exact expected checkout | All four marker lines intact | Operator-reported pass with screenshots, initial run |
| Terminal    | Fresh (`o`)        | Exact expected checkout | Empty new conversation       | Operator-reported pass, second run                   |
| Terminal    | Reply-seeded (`O`) | Exact expected checkout | All four marker lines intact | Operator-reported pass, second run                   |

### iTerm fresh

The initial runner recorded successful launch, an empty cwd answer, and `promptVerified: no`.
Screenshot 02 shows Claude Code with an empty conversation, 0 tokens, and an abbreviated checkout path ending in `fixture repos/Andrew's checkout`.
The operator subsequently confirmed that `no` was an input mistake and that the conversation was empty.
The second run supersedes that incomplete cwd observation: the operator recorded the full expected path, verified iTerm and Claude opened, confirmed an empty conversation, and closed the test window.

### iTerm reply-seeded

The runner recorded successful launch, the exact expected cwd, `promptVerified: yes`, and an identical expected/generated prompt SHA-256:

```plaintext
e171d4c00c69c76d8058e5ea88c188d86640bec31422c1526d2b52ab89c59a62
```

The prompt file hash proves the generated seed bytes, while the operator's observation and screenshots 05–06 supply the destination evidence.
Screenshot 05 shows the seeded conversation; screenshot 06 shows the agent's exact cwd response and these four lines:

```plaintext
HANDOFF-SMOKE-ALPHA
Quoted text: Andrew's "handoff" path.
Literal shell text: $HOME `printf SHOULD_NOT_RUN` $(printf SHOULD_NOT_RUN)
HANDOFF-SMOKE-OMEGA
```

The raw result reports `ownedWindowClosed: false` because pasted response text was consumed as the closure answer.
The operator later explicitly confirmed that all test Claude windows were closed.
Keep that correction separate from the unchanged raw record.

### Terminal fresh and reply-seeded

Both second-run cases recorded the exact expected checkout, `applicationVerified: yes`, `promptVerified: yes`, and `ownedWindowClosed: true`.
The fresh case opened an empty conversation; the reply-seeded case delivered the four marker lines above.
The saved Terminal seed matches the same SHA-256 as the initial iTerm seed.
These destination checks are structured operator reports, not observations made by the coordinating agent.

## Launch-command reconciliation

The second-run harness placed a recording shim ahead of `osascript` on its own process PATH.
The shim recorded the arguments received from the real `launchAll`, then forwarded them unchanged to `/usr/bin/osascript`.
Each new case has a generated-command record and a matching executed-command record with `captureOnly: false`, `nativeExecutionAttempted: true`, and `exitCode: 0`.
The exit code establishes launcher completion; the separate application, cwd, and prompt observations establish destination behavior.

| Case                  | Agent command                      | Command evidence                                                   | Opened application and agent                      |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| iTerm fresh           | `claude`                           | Captured invocation; matches generated arguments                   | Operator confirmed iTerm and Claude               |
| iTerm reply-seeded    | `claude "$(cat '<saved prompt>')"` | Reconstructed generated command, initial prompt PID 19085          | Initial run and screenshots show iTerm and Claude |
| Terminal fresh        | `claude`                           | Captured invocation; matches generated arguments                   | Operator confirmed Terminal and Claude            |
| Terminal reply-seeded | `claude "$(cat '<saved prompt>')"` | Captured invocation; matches generated arguments, prompt PID 72269 | Operator confirmed Terminal and Claude            |

The exact AppleScript payloads below are the argument following `osascript -e`.
The first, third, and fourth payloads match the recorded native invocations.
The second is a reconstruction, not a claim that the historical process arguments were captured.
`src/app.tsx`, `src/local.ts`, and `src/agent.ts` still match the source revision above.

### iTerm fresh

```applescript
tell application "iTerm"
    activate
    create window with default profile
    tell current session of current window to write text "cd '/Users/dongminyu/Development/01_personal/pr-loop-reviews/maintainer_tui/triage-handoff-2026-10-16/fixture repos/Andrew'\\''s checkout' && claude"
  end tell
```

### iTerm reply-seeded reconstruction

```applescript
tell application "iTerm"
    activate
    create window with default profile
    tell current session of current window to write text "cd '/Users/dongminyu/Development/01_personal/pr-loop-reviews/maintainer_tui/triage-handoff-2026-10-16/fixture repos/Andrew'\\''s checkout' && claude \"$(cat '/var/folders/rb/n38l4h_x6_927hsc8bmyl2980000gn/T/maintainer-triage-19085.md')\""
  end tell
```

### Terminal fresh

```applescript
tell application "Terminal"
    activate
    do script "cd '/Users/dongminyu/Development/01_personal/pr-loop-reviews/maintainer_tui/triage-handoff-2026-10-16/fixture repos/Andrew'\\''s checkout' && claude"
  end tell
```

### Terminal reply-seeded

```applescript
tell application "Terminal"
    activate
    do script "cd '/Users/dongminyu/Development/01_personal/pr-loop-reviews/maintainer_tui/triage-handoff-2026-10-16/fixture repos/Andrew'\\''s checkout' && claude \"$(cat '/var/folders/rb/n38l4h_x6_927hsc8bmyl2980000gn/T/maintainer-triage-72269.md')\""
  end tell
```

## Evidence provenance

The visible local evidence bundle is `pr-loop-reviews/maintainer_tui/triage-handoff-2026-10-16` beside the primary workspace.
It retains both raw `results.json` files, before/after character frames, generated seeds, runner sources, seven initial-run operator screenshots, and a separate `operator-corrections.json`.
The second run also retains per-case `*-generated-command.json` and `*-executed-command.json`, plus `prior-iTerm-seeded-command.json` with its reconstruction provenance.
Screenshots are numbered in attachment order as `native-screenshots/operator-01.png` through `operator-07.png`.
They remain local; this PR publishes the observations and evidence identifiers, not the raw screenshots.

The initial raw result SHA-256 is `d9326e2bac4c15f6d3fdec743b772ebfd9ef5b5ed8182c6ee39fe054c2bdc84f`.
The second raw result SHA-256 is `3a981e99b3b13899122e5816144325d3881e946731efeb0780d1c11b91c821a4`.
The prior command reconstruction SHA-256 is `c825f1781e670e57cbbda3c6fe7e26665146a505b4b68047589aa94f9b45e5aa`.
The operator supplied the screenshots and native observations; the coordinating agent compared those artifacts with the saved metadata, prompt bytes, and current source.
Native computer control rejected both terminal applications in this session, so the agent did not directly observe or execute a native handoff.
The agent's triage recommendations in the screenshots are outside this verification scope.

## Runner limitations and repair candidates

The first runner retained an animated test renderer during input and obscured its launch-status label beneath the transcript.
The corrected runner closes the overlay before reading status, destroys the renderer before input, and records Ctrl+C interruption.
Safe precondition, animation, and interruption checks passed; these checks do not establish terminal delivery.

The initial recorded run reached both iTerm cases.
Pasting a multiline response into its single-line evidence prompt fed later lines into the next question and stopped the run.
This is a runner input limitation and operator-reported interruption, not evidence of a production handoff defect.
The remaining-case runner replaced the free-text evidence prompt with validated short answers and automatically recorded launch commands.
Its completed run contains exactly the three missing cases; the earlier seeded iTerm observation remains unchanged.
No production repair candidate is established by the available evidence.

## Acceptance reconciliation

All four combinations have runtime destination observations, with exact checkout paths and fresh or seeded prompt behavior recorded.
Each generated command is reconciled with the opened application and configured agent; only the three second-run cases have captured native invocations.
The earlier seeded iTerm reconstruction is a retained evidence limitation, not a fourth captured invocation.
No required runtime observation remains pending for this smoke record.
The issue can close when this record merges after the PR checks and reviews.

The initial run's test-window closure is confirmed by the separate operator correction; all three second-run records confirm closure directly.
Preserve the visible evidence and inspect unique fixture files before removing the owned checkout and temporary prompts.
