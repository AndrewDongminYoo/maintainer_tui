# Quality Tooling Refresh

## Approved Scope

Refresh supported dependencies and existing quality tooling.
Preserve public APIs, generated artifacts and repository-specific boundaries.

## Compatibility Decisions

Use OpenTUI `0.7.0` and the latest compatible TypeScript `5.9.3`.
OpenTUI's `bun-ffi-structs 0.3.1` dependency requires TypeScript `^5`, so TypeScript `7.0.2` does not satisfy the installed peer graph.
Keep `react-devtools-core 7.0.1` because OpenTUI requires `^7.0.1` and the latest `8.0.0` is outside that range.
Align the existing CI Bun pin with the verified local and registry version `1.4.4`.
Keep the release-owned application version `0.5.0`.

## Acceptance

- Pinact remains locked to `4.1.1` with `lint` and `upgrade`.
- The full no-fix Trunk scan and declared project gates pass.
- Changed manifests have package-manager-generated lockfiles under repository policy.
- All installed required peer dependencies satisfy their declared version ranges.
- Advisory dispositions have specific evidence and affected knowledge claims are reconciled.

## Publication

Push and PR creation require explicit repository-specific approval.
After approval, continue the requested hosted gates, merge, cleanup and memory recording.
