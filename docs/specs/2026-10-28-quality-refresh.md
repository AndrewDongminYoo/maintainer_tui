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
- Changed manifests have package-manager-generated lock files under repository policy.
- All installed required peer dependencies satisfy their declared version ranges.
- Advisory dispositions have specific evidence and affected knowledge claims are reconciled.

## Publication

Push and PR creation require explicit repository-specific approval.
After approval, continue the requested hosted gates, merge, cleanup and memory recording.

## Filesystem Reader Follow-up

Use the reviewed standard-library reader and ten CLI regressions from `rn-typed-assets/.trunk/configs/`.
Include the reader in the copy sandbox through `direct_configs` and retain decoded findings at file level when a literal position is unavailable.
Keep `--no-verification --no-update`, omit secret values from SARIF messages and fail malformed input without partial clean output.
CI invokes the exact reader test file separately from the existing application checks.
Preserve application source, public contracts, package manifests, lock files, credentials, deployment paths and spelling coverage of owned files.
CSpell `10.4.0` declares Node `>=22.18.0`, so replace the unsupported managed Node `22.16.0` selection with available Node `22.23.4`.
The application remains on Bun `1.4.4`.

The CSpell-only vendor exclusion is a scoped correction after the unsupported-runtime failure was reproduced.
It does not exclude these files from secret scanning or other security gates.
British prose, Git/shell vocabulary and the Python reader use bundled dictionaries; project terms remain in the existing local dictionary.
Only the two known partial-render assertions and the historical temporary-path fragment receive file-local spelling directives.
