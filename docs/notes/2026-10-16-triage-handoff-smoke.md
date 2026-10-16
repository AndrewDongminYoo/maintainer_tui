# macOS triage handoff smoke record

## Status

Partial runtime evidence for [issue 19](https://github.com/AndrewDongminYoo/maintainer_tui/issues/19), recorded on 2026-10-16.
The iTerm reply-seeded handoff passed the observed cwd and prompt checks.
The iTerm fresh handoff opened an empty conversation, but its exact cwd was not recorded.
Neither Terminal case ran before the operator accidentally pasted a multiline Claude response into the runner and interrupted the remaining input sequence.
Keep the PR in draft and issue 19 open until the missing observations are recorded.
No production code changed for this verification task.

## Environment and fixture

- Source revision: `86ddd001fbfed8d93846a6e35068ed7d6cb35ca5`.
- macOS: 27.0.1, build 26A434.
- iTerm: 3.7.5, installed under the user's Applications directory.
- Terminal: 2.15; installed version only, with no runtime observation yet.
- Configured agent: Claude Code 2.1.301.
- Operator run: `run-2026-10-16T08-33-11.353Z`.
- Runner source SHA-256: `64efe61ed672bd8a44be806cf8905ef7c7748a709b590cadf5eb8d0af3ecd9ef`.

The expected checkout contains both spaces and an apostrophe:

```plaintext
/Users/dongminyu/Development/01_personal/pr-loop-reviews/maintainer_tui/triage-handoff-2026-10-16/fixture repos/Andrew's checkout
```

The harness supplies a deterministic multiline triage reply through the existing `startAgent` boundary, then drives the real `App` keyboard handler and production launch implementation.
The preceding one-shot triage call and GitHub data are controlled fixtures.
The destination is the real installed Claude Code application.

## Observed cases

| Application | Handoff            | Working directory                                 | Opening prompt                                                             | Result                           |
| ----------- | ------------------ | ------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------- |
| iTerm       | Fresh (`o`)        | Abbreviated path visible; full path not recorded  | Empty new conversation, confirmed by operator correction and screenshot 02 | Partial                          |
| iTerm       | Reply-seeded (`O`) | Exact observed path matches the expected checkout | All four marker lines confirmed intact                                     | Pass for cwd and prompt delivery |
| Terminal    | Fresh (`o`)        | Not observed                                      | Not observed                                                               | Not run                          |
| Terminal    | Reply-seeded (`O`) | Not observed                                      | Not observed                                                               | Not run                          |

### iTerm fresh

The runner recorded successful launch, an empty cwd answer, and `promptVerified: no`.
Screenshot 02 shows Claude Code with an empty conversation, 0 tokens, and an abbreviated checkout path ending in `fixture repos/Andrew's checkout`.
The operator subsequently confirmed that `no` was an input mistake and that the conversation was empty.
The correction does not supply the missing full cwd; that check remains open.

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

## Evidence provenance

The visible local evidence bundle is `pr-loop-reviews/maintainer_tui/triage-handoff-2026-10-16` beside the primary workspace.
It retains the raw `results.json`, before/after character frames, generated seed, runner source, seven operator screenshots, and a separate `operator-corrections.json`.
Screenshots are numbered in attachment order as `native-screenshots/operator-01.png` through `operator-07.png`.
They remain local; this PR publishes the observations and evidence identifiers, not the raw screenshots.

The raw result SHA-256 is `d9326e2bac4c15f6d3fdec743b772ebfd9ef5b5ed8182c6ee39fe054c2bdc84f`.
The operator supplied the screenshots and native observations; the coordinating agent compared those artifacts with the saved metadata, prompt bytes, and current source.
Native computer control rejected both terminal applications in this session, so the agent did not directly observe or execute a native handoff.
The agent's triage recommendations in the screenshots are outside this verification scope.

## Runner limitations and repair candidates

The first runner retained an animated test renderer during input and obscured its launch-status label beneath the transcript.
The corrected runner closes the overlay before reading status, destroys the renderer before input, and records Ctrl+C interruption.
Safe precondition, animation, and interruption checks passed; these checks do not establish terminal delivery.

The recorded rerun reached both iTerm cases.
Pasting a multiline response into its single-line evidence prompt fed later lines into the next question and stopped the run.
This is a runner input limitation and operator-reported interruption, not evidence of a production handoff defect.
For remaining checks, enter one short line per question and supply long responses or screenshots separately.
No production repair candidate is established by the available evidence.

## Remaining acceptance

1. Record the exact cwd returned by a fresh iTerm conversation.
2. Exercise Terminal fresh and reply-seeded handoffs and record cwd, prompt behavior, marker integrity, and test-window closure.
3. Capture the generated launch command for each application-and-handoff combination and reconcile it with the application and agent that actually opened.
   The current run did not persist a per-case launch-command record; cwd and prompt delivery alone do not satisfy that part of the contract.
4. Reconcile those observations before marking the PR ready or closing issue 19.

The operator confirmed the completed run's test windows are closed.
The owned checkout remains available for the outstanding cases; preserve evidence and inspect unique files before eventual cleanup.
