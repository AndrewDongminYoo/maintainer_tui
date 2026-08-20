#!/usr/bin/env bun
import { version } from "../package.json";

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { ThemeProvider } from "@/providers/theme-provider";

import { App } from "./app.tsx";
import { CONFIG_PATH, loadConfig, readCache, saveConfig, writeCache } from "./config.ts";
import {
  fetchSnapshot,
  filterRepos,
  needsRelease,
  releaseStatus,
  SNAPSHOT_SCHEMA_VERSION,
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
  maintainer --version       print the version and exit

Options
  --sort=activity|popular            default: activity
  --filter=all|attention|vuln|release  default: all
  --archived                         include archived repos, hidden by default
  --refresh                          ignore the cache
`;

function flag(name: string): string | undefined {
  const hit = process.argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
}

function writeStdout(output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const config = loadConfig();

if (flag("help") !== undefined || flag("h") !== undefined) {
  process.stdout.write(HELP);
  process.exit(0);
}

// Read from package.json rather than restated here, so the number cannot drift from the one the
// release is cut against. Bun bundles the import into the compiled binary.
if (flag("version") !== undefined) {
  process.stdout.write(`maintainer ${version}\n`);
  process.exit(0);
}

if (flag("config") !== undefined) {
  saveConfig(config);
  process.stdout.write(`${CONFIG_PATH}\n${JSON.stringify(config, null, 2)}\n`);
  process.exit(0);
}

const cachedValue = flag("refresh") === undefined ? readCache<Snapshot>(CACHE_TTL_MS) : null;
const cached = cachedValue?.schemaVersion === SNAPSHOT_SCHEMA_VERSION ? cachedValue : null;

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
  const showArchived = flag("archived") !== undefined;
  const pool = snapshot.repos.filter((r) => showArchived || !r.isArchived);

  await writeStdout(
    `${JSON.stringify(
      {
        viewer: snapshot.viewer,
        fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
        sort,
        filter,
        archived: showArchived,
        attention: snapshot.attention,
        repos: sortRepos(filterRepos(pool, filter), sort).map((repo) => ({
          ...repo,
          needsRelease: needsRelease(repo),
          releaseStatus: releaseStatus(repo),
          localPath: resolveLocal(locals, repo.nameWithOwner) ?? null,
        })),
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

if (!process.stdin.isTTY) {
  process.stderr.write("maintainer needs an interactive terminal; use --json when piping.\n");
  process.exit(1);
}

// Everything above returns before this line: creating the renderer takes exclusive ownership of
// stdin and stdout, so it must not run on the --json, --config or piped paths.
const renderer = await createCliRenderer();
createRoot(renderer).render(
  <ThemeProvider>
    <App config={config} initial={cached} />
  </ThemeProvider>,
);
