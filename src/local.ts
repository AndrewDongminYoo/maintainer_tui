import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { Config } from "./config.ts";

const run = promisify(execFile);

// cspell:words gitdir scriptable venv Worktrees
/** How many directory levels below each root are searched for clones. */
const SCAN_DEPTH = 2;

const SKIP = new Set(["node_modules", ".git", "Pods", "build", "vendor", ".venv", "DerivedData"]);
const stagedStatusCodes = new Set(["M", "A", "D", "R", "C", "T"]);
const modifiedStatusCodes = new Set(["M", "D", "T"]);

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

  let gitDir = gitPath;
  if (!stat.isDirectory()) {
    // Worktrees and submodules store `gitdir: <path>` in a plain file.
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, "utf8"))?.[1];
    if (!gitdir) return null;
    gitDir = resolve(dir, gitdir.trim());
  }

  try {
    // A linked worktree stores its own gitdir but shares configuration through `commondir`.
    // A submodule has no commondir, so its gitdir remains its configuration directory.
    const commonDir = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    gitDir = resolve(gitDir, commonDir);
  } catch {
    // A normal repository or submodule has no commondir.
  }

  try {
    const config = readFileSync(join(gitDir, "config"), "utf8");
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

/** The `path =` entries in a repo's `.gitmodules`, relative to it. Empty when it has none. */
function submodulePaths(dir: string): string[] {
  try {
    const modules = readFileSync(join(dir, ".gitmodules"), "utf8");
    return [...modules.matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((match) => (match[1] ?? "").trim());
  } catch {
    return [];
  }
}

/** Records one checkout under its canonical remote identity. False when it is not a repository. */
function register(found: Map<string, string>, dir: string): boolean {
  const url = originUrl(dir);
  if (!url) return false;

  const key = ownerRepo(url)?.toLowerCase();
  if (key && !found.has(key)) found.set(key, dir);
  return true;
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
      if (register(found, path)) {
        // A submodule is a checkout of a repository in its own right, and the enclosing repo is
        // the only place it can be reached from — the walk stops at a repo boundary, so without
        // this a submodule reads as never cloned. `.gitmodules` says where they are, which beats
        // descending into every repo looking.
        for (const relative of submodulePaths(path)) {
          const nested = join(path, relative);
          register(found, nested);
        }
        continue; // otherwise, don't descend into a repo looking for more repos
      }
      if (depth > 1) walk(path, depth - 1);
    }
  };

  for (const root of roots) walk(root, SCAN_DEPTH);
  return found;
}

/** Looks a repo up by its canonical remote identity. */
export function resolveLocal(
  found: Map<string, string>,
  nameWithOwner: string,
): string | undefined {
  return found.get(nameWithOwner.toLowerCase());
}

/** Produces the owner-scoped local checkout destination for a canonical GitHub repository name. */
export function cloneDestination(nameWithOwner: string, cloneRoot: string): string {
  const slash = nameWithOwner.indexOf("/");
  return join(cloneRoot, nameWithOwner.slice(0, slash), nameWithOwner.slice(slash + 1));
}

export async function cloneRepo(nameWithOwner: string, cloneRoot: string): Promise<string> {
  const dest = cloneDestination(nameWithOwner, cloneRoot);
  mkdirSync(dirname(dest), { recursive: true });
  await run("gh", ["repo", "clone", nameWithOwner, dest], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return dest;
}

const shq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const asq = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function iTermScript(path: string, command: string | null, mode: Config["mode"]): string {
  const line = asq(command ? `cd ${shq(path)} && ${command}` : `cd ${shq(path)}`);
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
  const line = asq(command ? `cd ${shq(path)} && ${command}` : `cd ${shq(path)}`);
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
  const base = existsSync(join(repoPath, "ios")) ? join(repoPath, "ios") : repoPath;
  return firstMatch(base, ".xcworkspace") ?? firstMatch(base, ".xcodeproj") ?? base;
}

/** Android Studio wants the Gradle root, which in a cross-platform checkout is `android/`. */
export function androidTarget(repoPath: string): string {
  const nested = join(repoPath, "android");
  return existsSync(nested) ? nested : repoPath;
}

/**
 * The shell command that starts an interactive agent, optionally seeded from a file.
 *
 * Both agents take a bare positional prompt (`codex [OPTIONS] [PROMPT]`, and `claude` the same),
 * so the seed could go on the command line — except that an AppleScript string literal cannot
 * span lines and a triage reply is a dozen of them. Passing the path and letting the new shell
 * read it keeps the command to one line, which is what has to survive `asq`.
 */
export function agentCommand(agent: string, promptFile?: string): string {
  return promptFile ? `${agent} "$(cat ${shq(promptFile)})"` : agent;
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
  if (app.includes("xcode")) return ["open", "-a", config.app, xcodeTarget(path)];
  if (app.includes("android studio")) return ["open", "-a", config.app, androidTarget(path)];
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

export interface CheckoutState {
  branch: string;
  /** Files with staged or unstaged changes, plus untracked ones. */
  dirty: number;
  /** Files whose index status is a normal staged change. */
  staged: number;
  /** Files whose worktree status is a normal modification. */
  modified: number;
  /** Files reported by porcelain as untracked (`??`). */
  untracked: number;
  /** Commits ahead of and behind the upstream **as of the last fetch**, not as of the remote. */
  ahead: number;
  behind: number;
  /** False when the branch has no upstream, which makes ahead/behind meaningless rather than 0. */
  tracked: boolean;
}

/**
 * Reads what the working copy is doing. This is the one signal GitHub cannot give.
 *
 * `--porcelain -b` answers branch, tracking and dirty files in a single ~20ms call, so it is
 * cheap enough to run for whichever repo is focused. It is deliberately not run across every
 * checkout: 70 of them would be a second and a half on each cursor move.
 *
 * The ahead/behind pair is measured against the last fetch. A checkout nobody has fetched in
 * weeks reports `behind 0` while origin has moved on, so callers have to say "since last fetch"
 * rather than imply the remote was consulted. The dirty count carries no such caveat.
 */
export async function checkoutState(path: string): Promise<CheckoutState> {
  const { stdout } = await run("git", ["-C", path, "status", "--porcelain", "--branch"]);
  const [header = "", ...rows] = stdout.split("\n");
  const changes = rows.filter((row) => row.trim() !== "");

  // `## main...origin/main [ahead 10, behind 2]`, or `## main` with no upstream.
  const branch = /^## (?:No commits yet on )?([^.\s]+)/.exec(header)?.[1] ?? "?";
  const count = (word: string): number =>
    Number(new RegExp(`${word} (\\d+)`).exec(header)?.[1] ?? 0);

  return {
    branch,
    dirty: changes.length,
    staged: changes.filter((row) => stagedStatusCodes.has(row[0] ?? "")).length,
    modified: changes.filter((row) => modifiedStatusCodes.has(row[1] ?? "")).length,
    untracked: changes.filter((row) => row.startsWith("??")).length,
    ahead: count("ahead"),
    behind: count("behind"),
    tracked: header.includes("..."),
  };
}

export interface LaunchResult {
  path: string;
  ok: boolean;
  error?: string;
}

export async function launchAll(paths: string[], config: Config): Promise<LaunchResult[]> {
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
