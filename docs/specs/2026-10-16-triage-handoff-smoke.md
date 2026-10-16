# macOS triage handoff smoke contract

## Scope

[Issue 19](https://github.com/AndrewDongminYoo/maintainer_tui/issues/19) requires runtime evidence for focused-repository handoff in iTerm and Terminal.
Exercise `o` for a fresh conversation and `O` for a reply-seeded conversation in each application.
Keep production code unchanged; an observed failure becomes a separate repair candidate.

## Acceptance

1. Use a controlled local checkout with spaces and an apostrophe in its path.
2. Drive the real `App` keyboard handler and production launch implementation with the configured agent.
3. Use a deterministic multiline triage reply as the handoff precondition, and disclose that the preceding one-shot triage response is a fixture.
4. Record macOS, terminal application, and agent versions; the launched application and command; observed working directory; opening prompt behavior; and evidence for all four combinations.
5. Distinguish recorded launch success, operator-observed terminal results, and unverified properties.
   A compiled AppleScript or a generated prompt file alone does not prove delivery into the new conversation.
6. Publish a smoke record with pass/fail or blocked results and reproducible failures.
   Do not close the issue while a required combination lacks runtime observation.

## Execution boundary

Native computer control rejected access to both `com.googlecode.iterm2` and `com.apple.Terminal` in this session.
Prepare a user-run harness rather than bypassing that boundary through another automation interface.
The agent may validate fixture setup and the pre-handoff rendered panel without invoking either terminal application.
The operator must run the native handoffs and supply their observations.

## Precedent

Oracle sources `wiki/sources/maintainer_tui--claude.md` and `raw/sources/maintainer_tui/CLAUDE.md` describe the `shq` and `asq` escaping layers and the split between pure `launchArgv` and executable `launchAll`.
The indexed source revision is `c1681868ac634e4b2414874716bb75a7864113c4`, with unverified freshness; current `CLAUDE.md` and `src/local.ts` confirm those claims.
That precedent confirms the need to observe actual runtime working directories and prompts separately from syntax checks.
The scoped lookup found no actual four-case macOS handoff record.
