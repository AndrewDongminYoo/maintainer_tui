#!/usr/bin/env bun
import { render } from "ink";
import * as React from "react";

import { ThemeProvider } from "@/providers/theme-provider";

import { App } from "./app.tsx";
import {
  CONFIG_PATH,
  loadConfig,
  readCache,
  saveConfig,
  writeCache,
} from "./config.ts";
import {
  fetchSnapshot,
  filterRepos,
  needsRelease,
  sortRepos,
  type FilterMode,
  type Snapshot,
  type SortMode,
} from "./github.ts";
import { resolveLocal, scanRoots } from "./local.ts";

const CACHE_TTL_MS = 10 * 60 * 1000;

const HELP = `maintainer — GitHub maintenance dashboard

  maintainer                 interactive TUI
  maintainer --json          print the sorted listing and exit
  maintainer --config        print the resolved config path and values

Options
  --sort=activity|popular            default: activity
  --filter=all|attention|vuln|release  default: all
  --refresh                          ignore the cache
`;

function flag(name: string): string | undefined {
  const hit = process.argv.find(
    (arg) => arg === `--${name}` || arg.startsWith(`--${name}=`),
  );
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
}

const config = loadConfig();

if (flag("help") !== undefined || flag("h") !== undefined) {
  process.stdout.write(HELP);
  process.exit(0);
}

if (flag("config") !== undefined) {
  saveConfig(config);
  process.stdout.write(`${CONFIG_PATH}\n${JSON.stringify(config, null, 2)}\n`);
  process.exit(0);
}

const cached =
  flag("refresh") === undefined ? readCache<Snapshot>(CACHE_TTL_MS) : null;

if (flag("json") !== undefined) {
  // A stack trace is the wrong answer to "gh is not installed" or "you are not logged in".
  const snapshot =
    cached ??
    (await fetchSnapshot().catch((error: Error) => {
      process.stderr.write(`maintainer: ${error.message}\n`);
      process.exit(1);
    }));
  if (!cached) writeCache(snapshot);

  const locals = scanRoots(config.roots);
  const sort = (flag("sort") || "activity") as SortMode;
  const filter = (flag("filter") || "all") as FilterMode;

  process.stdout.write(
    `${JSON.stringify(
      {
        viewer: snapshot.viewer,
        fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
        sort,
        filter,
        attention: snapshot.attention,
        repos: sortRepos(filterRepos(snapshot.repos, filter), sort).map(
          (repo) => ({
            ...repo,
            needsRelease: needsRelease(repo),
            localPath: resolveLocal(locals, repo.nameWithOwner) ?? null,
          }),
        ),
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

if (!process.stdin.isTTY) {
  process.stderr.write(
    "maintainer needs an interactive terminal; use --json when piping.\n",
  );
  process.exit(1);
}

const instance = render(
  <ThemeProvider>
    <App config={config} initial={cached} />
  </ThemeProvider>,
);

// Unmounting alone leaves the process alive for several seconds while Bun waits on the raw-mode
// stdin stream, which reads as "q did nothing". Exit as soon as the app has torn down.
await instance.waitUntilExit();
process.exit(0);
