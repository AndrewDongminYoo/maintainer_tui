import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { Config } from "./config.ts";

const run = promisify(execFile);

// cspell:words gitdir scriptable venv Worktrees
/** How many directory levels below each root are searched for clones. */
const SCAN_DEPTH = 2;

const SKIP = new Set([
  "node_modules",
  ".git",
  "Pods",
  "build",
  "vendor",
  ".venv",
  "DerivedData",
]);

/**
 * Reads the origin remote straight out of `.git/config`.
 *
 * Using the presence of `.git` as the repo-root test is what keeps a nested directory from
 * resolving to an enclosing repository: `git -C <dir> remote get-url origin` walks upward and
 * happily answers with the parent's remote, so every plain subdirectory of a git root would
 * otherwise read as an existing clone.
 */
function originUrl(dir: string): string | null {
  const gitPath = join(dir, ".git");
  const stat = statSync(gitPath, { throwIfNoEntry: false });
  if (!stat) return null;

  let configPath = join(gitPath, "config");
  if (!stat.isDirectory()) {
    // Worktrees and submodules store `gitdir: <path>` in a plain file.
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, "utf8"))?.[1];
    if (!gitdir) return null;
    configPath = resolve(dir, gitdir.trim(), "config");
  }

  try {
    const config = readFileSync(configPath, "utf8");
    return /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** `git@github.com:owner/name.git` and `https://github.com/owner/name` both yield `owner/name`. */
export function ownerRepo(url: string): string | null {
  const match = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Maps `owner/name` (lowercased) to an absolute clone path.
 *
 * Keyed on the remote rather than the directory name because the two routinely diverge —
 * `bootstrap_icons/` on disk is `AndrewDongminYoo/Bootstrap-Icons-Flutter` on GitHub.
 * Earlier roots win, so the cwd shadows configured roots.
 */
export function scanRoots(roots: string[]): Map<string, string> {
  const found = new Map<string, string>();

  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !SKIP.has(e.name))
        .map((e) => e.name);
    } catch {
      return;
    }

    for (const name of entries) {
      const path = join(dir, name);
      const url = originUrl(path);
      if (url) {
        const key = ownerRepo(url)?.toLowerCase();
        if (key && !found.has(key)) found.set(key, path);
        // Bare-name fallback for repos renamed on GitHub, where the API's new name no longer
        // matches the old URL still sitting in .git/config. Cannot collide with the keys above,
        // which always contain a slash.
        const bare = name.toLowerCase();
        if (!found.has(bare)) found.set(bare, path);
        continue; // don't descend into a repo looking for more repos
      }
      if (depth > 1) walk(path, depth - 1);
    }
  };

  for (const root of roots) walk(root, SCAN_DEPTH);
  return found;
}

/** Looks a repo up by its remote first, then by bare directory name. */
export function resolveLocal(
  found: Map<string, string>,
  nameWithOwner: string,
): string | undefined {
  const lower = nameWithOwner.toLowerCase();
  return found.get(lower) ?? found.get(lower.slice(lower.indexOf("/") + 1));
}

export async function cloneRepo(
  nameWithOwner: string,
  cloneRoot: string,
): Promise<string> {
  const dest = join(
    cloneRoot,
    nameWithOwner.slice(nameWithOwner.indexOf("/") + 1),
  );
  await run("gh", ["repo", "clone", nameWithOwner, dest], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return dest;
}

const shq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const asq = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function iTermScript(
  path: string,
  command: string | null,
  mode: Config["mode"],
): string {
  const line = asq(
    command ? `cd ${shq(path)} && ${command}` : `cd ${shq(path)}`,
  );
  const spawn =
    mode === "window"
      ? `create window with default profile`
      : `if (count of windows) = 0 then
      create window with default profile
    else
      tell current window to create tab with default profile
    end if`;
  return `tell application "iTerm"
    activate
    ${spawn}
    tell current session of current window to write text "${line}"
  end tell`;
}

function terminalScript(path: string, command: string | null): string {
  // Terminal.app's `do script` always opens a new window; it has no scriptable tab spawn.
  const line = asq(
    command ? `cd ${shq(path)} && ${command}` : `cd ${shq(path)}`,
  );
  return `tell application "Terminal"
    activate
    do script "${line}"
  end tell`;
}

const firstMatch = (dir: string, suffix: string): string | undefined => {
  try {
    const hit = readdirSync(dir)
      .filter((name) => name.endsWith(suffix))
      .sort()[0];
    return hit ? join(dir, hit) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Xcode wants the workspace or project, not the repo.
 *
 * In a Flutter or React Native checkout those live under `ios/`, so that is searched first;
 * a workspace beats a project because opening the project of a CocoaPods app builds the
 * wrong thing.
 */
export function xcodeTarget(repoPath: string): string {
  const base = existsSync(join(repoPath, "ios"))
    ? join(repoPath, "ios")
    : repoPath;
  return (
    firstMatch(base, ".xcworkspace") ?? firstMatch(base, ".xcodeproj") ?? base
  );
}

/** Android Studio wants the Gradle root, which in a cross-platform checkout is `android/`. */
export function androidTarget(repoPath: string): string {
  const nested = join(repoPath, "android");
  return existsSync(nested) ? nested : repoPath;
}

/** Builds the argv that opens one repo, picking the richest strategy the chosen app supports. */
export function launchArgv(path: string, config: Config): string[] {
  const app = config.app.toLowerCase();

  if (app.includes("iterm"))
    return ["osascript", "-e", iTermScript(path, config.command, config.mode)];
  if (app === "terminal" || app === "terminal.app") {
    return ["osascript", "-e", terminalScript(path, config.command)];
  }
  if (app.includes("warp")) {
    // Warp's URI scheme honours mode but has no way to run a command in the new session.
    const action = config.mode === "window" ? "new_window" : "new_tab";
    return ["open", `warp://action/${action}?path=${encodeURIComponent(path)}`];
  }
  if (app.includes("xcode"))
    return ["open", "-a", config.app, xcodeTarget(path)];
  if (app.includes("android studio"))
    return ["open", "-a", config.app, androidTarget(path)];
  return ["open", "-a", config.app, path];
}

/** True when the configured app can honour `config.command`. */
export function supportsCommand(config: Config): boolean {
  const app = config.app.toLowerCase();
  return app.includes("iterm") || app.startsWith("terminal");
}

/** Hands a URL to the default browser. Repos get `launchArgv`; a pull request is just a page. */
export async function openUrl(url: string): Promise<void> {
  await run("open", [url]);
}

/**
 * Copies text to the macOS clipboard.
 *
 * The renderer holds mouse tracking for the whole session, which is what takes the terminal's own
 * selection away — text inside the TUI cannot be dragged over and copied at all. So getting an
 * agent's reply out of the screen has to be a command, not a gesture.
 */
export function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pbcopy");
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}`)),
    );
    child.stdin?.end(text);
  });
}

export interface LaunchResult {
  path: string;
  ok: boolean;
  error?: string;
}

export async function launchAll(
  paths: string[],
  config: Config,
): Promise<LaunchResult[]> {
  const results: LaunchResult[] = [];
  for (const path of paths) {
    const [command = "open", ...args] = launchArgv(path, config);
    try {
      await run(command, args);
      results.push({ path, ok: true });
    } catch (error) {
      results.push({ path, ok: false, error: (error as Error).message });
    }
  }
  return results;
}
