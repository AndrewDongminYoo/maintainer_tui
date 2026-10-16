# macOS triage handoff smoke plan

## Workspace and authority

Follow [the smoke contract](../specs/2026-10-16-triage-handoff-smoke.md) on `codex/triage-handoff-smoke` in the primary workspace.
The operator authorized the next existing issue through `pr-loop` after PR 29 cleanup.
This is verification and documentation work; production repairs are outside scope.

## Steps

1. Record current versions and inspect the real focused-repository handoff path.
   Verify: source, installed application metadata, and agent version output.
2. Create one disposable local checkout at a path containing spaces and an apostrophe, and prepare a controlled multiline reply.
   Verify: exact Git root, origin identity, source revision, and fixture contents.
3. Prepare a user-run harness that renders the real `App`, supplies the controlled triage result, and drives `g` then `o` or `O` through `processParsedKey`.
   Verify its pre-handoff observation with a failing negative control followed by a passing check; do not invoke the native launch from automated tool execution.
4. Have the operator run iTerm/fresh, iTerm/seeded, Terminal/fresh, and Terminal/seeded sequentially.
   Verify: generated launch command reconciled with the opened application and agent, observed cwd, opening prompt state, multiline marker integrity, and owned-window closure recorded per case.
5. Complete the smoke record, separate any repair candidates, and reconcile directly affected documentation.
   Verify: evidence links, case completeness, explicit observation provenance, scoped Trunk checks, and whitespace checks.
6. Review the documentation candidate, commit, push, open a PR, and finish hosted review and CI.
   Do not claim runtime acceptance or close issue 19 while required observations remain pending.

## Cleanup

Keep the visible report and evidence after completion.
Remove only the owned fixture checkout and generated temporary prompt after its launched agent sessions are confirmed closed and unique files are preserved.
Do not alter the operator's normal maintainer configuration or existing terminal windows.
