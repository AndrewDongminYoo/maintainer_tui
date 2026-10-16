# Reject malformed snapshot caches

## Problem

[Issue #13](https://github.com/AndrewDongminYoo/maintainer_tui/issues/13) reports that missing or nonnumeric cache timestamps bypass expiry checks and malformed snapshot fields reach JSON output or TUI initialization.

## Contract

Treat an unreadable cache, invalid JSON, an invalid timestamp, an expired entry, an unsupported schema version, or malformed required snapshot fields as a cache miss.
Keep the existing ten-minute CLI TTL and schema version.
A cache timestamp must be a finite nonnegative number no later than the current time.

Validate the complete `Snapshot` at the CLI consumption boundary before either JSON output or the initial TUI props use it.
Check the viewer, repository array, three PR buckets, and their required nested fields against the existing TypeScript contract.
Counts must be finite nonnegative integers, PR numbers positive integers, and date strings parseable.
Preserve nullable repository metadata, valid empty collections, and unknown extra fields.
Do not silently replace malformed fields with defaults or accept a partial snapshot.

## Acceptance criteria

- Isolated cache fixtures cover missing, string, null, nonfinite, future, and expired timestamps, malformed JSON, and schema mismatches.
- Invalid required snapshot fields and nested repository, release, and PR fields are rejected before TUI initialization.
- JSON startup falls back to the existing fetch path on a cache miss without consuming malformed data.
- Valid empty and populated caches reach JSON output and initial TUI props without a GitHub call.
- `--refresh` still bypasses a valid cache.
- Focused CLI tests, the full suite, type checking, scoped Trunk checks, and hosted CI pass.

## Boundaries

No new dependency, schema migration, cache format change, network response validation, UI layout change, or cache repair policy.
Test GitHub calls through the existing fake executable, without live credentials or requests.

## Precedent

Oracle returned `wiki/sources/maintainer_tui--claude.md`, which describes `Snapshot` as the shared cache and state unit.
The current `CLAUDE.md` confirms that invariant, so validation keeps or rejects the complete snapshot.
The same indexed source's claim that `gh` is never mocked is stale and is not applied.
