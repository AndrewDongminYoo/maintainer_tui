# maintainer

<!-- cspell:words Behaviour -->

A terminal dashboard over every repository you can push to, built for the "open everything I need to look at, then leave the house" workflow.

It lists your repos with the maintenance signals that decide whether a repo needs you — open PRs, Dependabot alerts, unreleased commits — lets you check off the ones worth opening, and launches each one in your terminal or editor.
Optionally it runs `claude` or `codex` in the checkout so a session is already warm when you get to it.

## Install

```bash
bun install
bun link          # exposes `maintainer` on PATH
```

Requires [`gh`](https://cli.github.com) authenticated with the `repo` scope, and Bun.

## Use

```bash
maintainer                    # interactive TUI
maintainer --json             # the same listing, as JSON
maintainer --json --filter=vuln --sort=popular
maintainer --config           # write and print the config file
```

| Key              | Action                                                 |
| ---------------- | ------------------------------------------------------ |
| `↑`/`↓`, `j`/`k` | move                                                   |
| `space`          | select                                                 |
| `a` / `A`        | select all visible / clear                             |
| `s`              | cycle sort: `activity` → `popular`                     |
| `f`              | cycle filter: `all` → `attention` → `vuln` → `release` |
| `o`              | open selection                                         |
| `c`              | clone whatever in the selection is missing locally     |
| `g`              | agent triage on the focused repo                       |
| `r`              | refetch                                                |
| `?`              | help                                                   |

## Sorting

`activity` is two-tier.
Repos with an open issue or PR come first, ordered by the most recent of those conversations; everything else follows, ordered by last push.
A repo with a lively discussion outranks one that was merely pushed to yesterday.

`popular` orders by stargazers, then forks, then watchers.

## Signals

| Column | Meaning                                           |
| ------ | ------------------------------------------------- |
| `⚠ n`  | open Dependabot alerts                            |
| `n PR` | open pull requests                                |
| `bump` | the default branch moved after the latest release |

The header also counts PRs where your review is requested and PRs you authored, fetched globally rather than derived per repo.

Archived repositories report zero alerts.
That is GitHub's answer, not a gap in this tool — Dependabot is disabled on archive, and the REST endpoint returns `403` for the same repos.

## Configuration

`~/.config/maintainer-tui/config.json`, created by `maintainer --config`.

```json
{
  "roots": ["/Users/you/Development"],
  "cloneRoot": "/Users/you/Development",
  "app": "Warp",
  "mode": "tab",
  "command": null,
  "agent": "claude"
}
```

`roots` are searched two levels deep for existing checkouts.
The current directory is always searched first, and when it is itself a checkout its parent is searched too — so running `maintainer` from inside any project finds all of its siblings without configuration.

Clones are matched by their `origin` remote rather than by directory name, because the two drift: `codicons/` on disk is `vscode_codicons` on GitHub.
Bare directory name is a fallback, which covers repos renamed on GitHub after you cloned them.

### `app` and `mode`

| `app`         | Behaviour                                                    |
| ------------- | ------------------------------------------------------------ |
| `iTerm`       | new tab or window per repo, and runs `command`               |
| `Terminal`    | new window per repo, and runs `command`; `mode` is ignored   |
| `Warp`        | new tab per repo via Warp's URI scheme; cannot run `command` |
| anything else | `open -a "<app>" <path>`                                     |

Set `command` to `claude` to have a session waiting in every repo you opened.
Only iTerm and Terminal can honour it — Warp's URI scheme accepts a path but no command.

Warp opens a tab in its active window, or a new window when it has none.

One caveat that belongs to macOS rather than to this tool: opening an app that is not already
running launches it, and a terminal that restores its previous window arrangement on launch will
put all of those windows back alongside the ones you asked for.
Start the app yourself first if that matters.

## Development

```bash
bun test          # pure logic: sorting, remote parsing, clone detection, launch argv
bun run typecheck
```

The TUI needs a real TTY, so `--json` is the path to exercise the data layer from a script or a CI job.
UI components come from [termcn](https://www.termcn.dev) and live in `src/components/ui`; they are checked in and yours to edit.
