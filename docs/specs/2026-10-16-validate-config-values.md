# Validate configuration before use

## Problem

[Issue #12](https://github.com/AndrewDongminYoo/maintainer_tui/issues/12) identifies unchecked configuration values in `loadConfig()`.
A string `roots` value is spread into characters, null roots fail during spreading, and invalid application or agent values reach their consumers.

## Contract

Require the top-level JSON value to be an object rather than null, an array, or a primitive.
Validate only supplied known fields before merging defaults or deriving roots.

| Field       | Accepted value                             |
| ----------- | ------------------------------------------ |
| `roots`     | Array of strings                           |
| `cloneRoot` | String                                     |
| `app`       | String, including custom application names |
| `mode`      | `tab` or `window`                          |
| `command`   | String or null                             |
| `agent`     | `claude` or `codex`                        |

Reject invalid values with an error naming the configuration path, invalid field, and expected type or supported values.
Keep the existing malformed-JSON error behavior separate from field validation errors.
Preserve defaults, valid partial files, implicit roots, root deduplication, and existing unknown-field behavior.

## Acceptance criteria

- Isolated subprocess fixtures reject invalid top-level values, invalid field types, mixed-type roots, and unsupported enum values.
- Errors identify the configuration file and field before GitHub or renderer startup.
- Absent, empty, partial, and complete valid configuration preserve existing behavior.
- Custom application names, null commands, and both supported mode and agent values remain accepted.
- `bun test src/cli.test.ts`, `bun test`, `bun run typecheck`, scoped Trunk checks, and hosted CI pass.

## Boundaries

Do not add dependencies, a schema framework, filesystem existence checks, absolute-path restrictions, new string-content restrictions, or unknown-field rejection.
Keep public APIs, launch behavior, cache handling, and informational CLI exits unchanged.
Diagnostic validation does not require visual approval.
