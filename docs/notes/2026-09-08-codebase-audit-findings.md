# Codebase Audit Findings

## Scope

This audit reviewed the application source, tests, documentation, dependency manifest, Trunk configuration, and GitHub Actions workflow at commit `35fa24c3d9534322f33f2008a21693cf9d23b101`.
The audit did not inspect a published Homebrew artifact or call the live GitHub API.

## Baseline Evidence

- `bun test` passed 70 tests with 188 assertions.
- `bun run typecheck` passed.
- `trunk check --all --no-progress` checked 131 files and reported no issues.
- A plain `trunk check` inspected no files because the worktree was clean.
- `HEAD` matched `origin/main` before implementation started.

## Findings

### F-01: Local Repository Identity Is Ambiguous

Priority: P0.
Status: Resolved.

At the audited baseline, `scanRoots` recorded each checkout by its canonical `owner/name` and by its bare directory name.
`resolveLocal` used the bare name when the canonical key was absent.
This fallback could resolve `owner-two/foo` to a checkout for `owner-one/foo`.
The audit reproduced this result with two owners that used the same repository name.

`cloneRepo` also omitted the owner from the destination path.
This path could not represent two repositories that had the same name and different owners.

Linked worktrees were another missing identity case.
The `.git` file pointed to a worktree Git directory, but the shared repository configuration was behind its `commondir` file.
The reader looked only for `<gitdir>/config`.
The audit reproduced a linked worktree that produced no local repository key.

Acceptance criteria:

- A repository cannot resolve to a checkout for another owner.
- Two repositories with the same name can have distinct clone destinations.
- A linked worktree resolves through its common Git configuration.
- Real Git fixtures cover all three cases.

Resolution evidence:

- `scanRoots` and `resolveLocal` now use only the canonical remote identity.
- `cloneDestination` includes both the owner and repository name.
- The Git metadata reader follows `commondir` for linked worktrees.
- Real Git fixtures cover cross-owner name collisions and a linked worktree, and a destination test covers both owners.

### F-02: Unavailable Vulnerability Data Becomes Zero

Priority: P0.
Status: Resolved.

GitHub could return `vulnerabilityAlerts: null` when the token could not read alert data.
At the audited baseline, `toRepo` converted that value to `vulnCount: 0`.
The vulnerability filter and repository row then treated an unknown value as a confirmed zero.

Acceptance criteria:

- The repository model preserves unavailable alert data as `null`.
- JSON output keeps the distinction between `null` and `0`.
- The TUI shows an explicit unknown marker.
- The vulnerability and attention filters apply a documented policy to unknown values.
- A partial GraphQL response regression test covers the unavailable state.

Resolution evidence:

- `Repo.vulnCount` now preserves `null`, which JSON serialization retains unchanged.
- The repository row shows `⚠ ?`, and the vulnerability and attention filters keep unavailable data actionable.
- A fake `gh` executable returns a partial GraphQL response and verifies the unavailable state.

### F-03: Agent Run Completion Can Mutate a New Run

Priority: P1.
Status: Resolved.

At the audited baseline, the triage completion handler cleared `agentRun.current` without checking whether it still owned that slot.
If an operator cancelled one run and started another before the first promise settled, the first `finally` block could clear the second run's cancel handle and busy status.

`runAgent` sent a signal only to the direct child process.
This behavior did not guarantee that commands started by the agent process terminated with it.

Acceptance criteria:

- A stale run cannot clear or update a newer run.
- Closing the overlay cancels the current run only.
- Cancellation and timeout use one process-tree termination policy.
- Tests cover cancel, restart, stale completion, timeout, and descendant cleanup behavior.

Resolution evidence:

- Triage completion now updates output, status, and the cancel handle only when the completing run still owns the slot.
- `runAgent` creates a detached POSIX process group, sends `SIGTERM` on cancellation, and escalates to `SIGKILL` after a grace period.
- Timeout sends `SIGKILL` to the same process group immediately.
- Integration tests cover stale resolve and reject outcomes, restarted-run cancellation, direct cancellation, forced cancellation when a descendant ignores `SIGTERM`, timeout, descendant termination, and an unrelated process group.

### F-04: Refresh and Clone Operations Can Overlap

Priority: P1.
Status: Resolved.

At the audited baseline, the initial refresh and the `r` key could start concurrent requests.
An older request could finish last and overwrite the current snapshot, local checkout map, status, and persistent cache.

The `c` key could also start the same clone operation more than once before the first operation updated local state.
Keyboard repeat metadata and the busy state did not guard this command.

Acceptance criteria:

- Only the latest refresh can publish state or write the cache.
- A repository cannot have more than one clone operation in flight.
- Repeated command keys do not start duplicate clone operations.
- Tests use controlled promises to complete requests in reverse order.

Resolution evidence:

- Refresh generations allow only the latest request to publish the snapshot, selection, local map, status, and cache.
- One in-flight guard prevents duplicate clone commands and resets after either success or failure.
- Controlled promises verify reverse refresh completion, repeated clone input, and retry after failure.

### F-05: CI Does Not Verify the Release Artifact Contract

Priority: P2.
Status: Resolved.

At the audited baseline, the build command used the host target, but the archive name stated `darwin-arm64`.
The CI workflow did not build the standalone executable.
It also did not start the native OpenTUI renderer from a clean directory without `node_modules`.

Acceptance criteria:

- The release build selects its target explicitly.
- CI builds the same standalone executable that the release process archives.
- A smoke test starts the native renderer from outside the repository.
- The smoke test reaches `createCliRenderer` instead of exiting through `--help` or `--version`.

Resolution evidence:

- The build command now selects `bun-darwin-arm64`, and CI runs that same command.
- The smoke script copies the binary outside the repository, supplies isolated cache and config roots, waits for the rendered application title, sends `q`, and requires a zero exit code.
- Local verification identified the result as a `Mach-O 64-bit executable arm64` and completed the smoke path successfully.

## Priority Order

1. Fix F-01 because it can direct commands and agents at the wrong checkout.
2. Fix F-02 because the dashboard must not present unavailable security data as a confirmed zero.
3. Fix F-03 because cancellation must keep ownership of the correct process.
4. Fix F-04 because overlapping work can publish stale data or duplicate filesystem operations.
5. Fix F-05 because the release artifact needs a repeatable acceptance gate.
