import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { triagePrompt } from "./agent.ts";
import type { Config } from "./config.ts";
import {
  filterRepos,
  needsRelease,
  prQueue,
  prSearchArgs,
  SNAPSHOT_SCHEMA_VERSION,
  sortRepos,
  type PrRef,
  type Repo,
} from "./github.ts";
import {
  agentCommand,
  androidTarget,
  checkoutState,
  launchArgv,
  ownerRepo,
  scanRoots,
  xcodeTarget,
} from "./local.ts";

// cspell:words normalises osacompile purrfect scpt
const repo = (over: Partial<Repo>): Repo => ({
  nameWithOwner: "o/r",
  url: "",
  isPrivate: false,
  isArchived: false,
  isFork: false,
  pushedAt: "2026-01-01T00:00:00Z",
  stars: 0,
  forks: 0,
  watchers: 0,
  language: null,
  openIssues: 0,
  openPrs: 0,
  lastActivityAt: null,
  vulnCount: 0,
  latestRelease: null,
  ...over,
});

test("activity sort puts repos with open issues/PRs first, then falls back to pushedAt", () => {
  const quietButRecent = repo({
    nameWithOwner: "o/quiet",
    pushedAt: "2026-08-15T00:00:00Z",
  });
  const busyButOld = repo({
    nameWithOwner: "o/busy",
    pushedAt: "2020-01-01T00:00:00Z",
    openPrs: 1,
    lastActivityAt: "2026-02-01T00:00:00Z",
  });
  const busier = repo({
    nameWithOwner: "o/busier",
    pushedAt: "2020-01-01T00:00:00Z",
    openIssues: 1,
    lastActivityAt: "2026-07-01T00:00:00Z",
  });
  const stale = repo({
    nameWithOwner: "o/stale",
    pushedAt: "2019-01-01T00:00:00Z",
  });

  expect(
    sortRepos([quietButRecent, busyButOld, busier, stale], "activity").map((r) => r.nameWithOwner),
  ).toEqual(["o/busier", "o/busy", "o/quiet", "o/stale"]);
});

test("popularity sort ranks by stars, then forks, then watchers", () => {
  const a = repo({ nameWithOwner: "o/a", stars: 5 });
  const b = repo({ nameWithOwner: "o/b", stars: 9 });
  const c = repo({ nameWithOwner: "o/c", stars: 5, forks: 3 });

  expect(sortRepos([a, b, c], "popular").map((r) => r.nameWithOwner)).toEqual([
    "o/b",
    "o/c",
    "o/a",
  ]);
});

test("needsRelease only fires when the default branch is ahead of the release tag", () => {
  expect(needsRelease(repo({ latestRelease: null }))).toBe(false);
  expect(
    needsRelease(
      repo({
        latestRelease: {
          tagName: "v1",
          createdAt: "2026-01-01T00:00:00Z",
          defaultBranchAheadBy: 1,
        },
      }),
    ),
  ).toBe(true);
  expect(
    needsRelease(
      repo({
        latestRelease: {
          tagName: "v1",
          createdAt: "2026-05-01T00:00:00Z",
          defaultBranchAheadBy: 0,
        },
      }),
    ),
  ).toBe(false);
});

test("needsRelease ignores pushes that did not move the default branch", () => {
  expect(
    needsRelease(
      repo({
        pushedAt: "2026-08-01T00:00:00Z",
        latestRelease: {
          tagName: "v1",
          createdAt: "2026-01-01T00:00:00Z",
          defaultBranchAheadBy: 0,
        },
      }),
    ),
  ).toBe(false);
});

test("needsRelease detects default-branch commits by ancestry instead of timestamp", () => {
  const latestRelease = {
    tagName: "v1",
    createdAt: "2026-01-01T00:00:00Z",
    defaultBranchAheadBy: 1,
  };

  expect(
    needsRelease(
      repo({
        pushedAt: "2025-12-01T00:00:00Z",
        latestRelease,
      }),
    ),
  ).toBe(true);
});

test("release filter keeps incomparable release tags actionable", () => {
  const incomparable = repo({
    latestRelease: {
      tagName: "v1",
      createdAt: "2026-01-01T00:00:00Z",
      defaultBranchAheadBy: null,
    },
  });

  expect(filterRepos([incomparable], "release")).toEqual([incomparable]);
});

test("triage prompt preserves an unavailable release comparison", () => {
  const incomparable = repo({
    latestRelease: {
      tagName: "v1",
      createdAt: "2026-01-01T00:00:00Z",
      defaultBranchAheadBy: null,
    },
  });

  expect(triagePrompt(incomparable)).toContain("default-branch comparison unavailable");
});

test("the JSON command flushes a large snapshot through a pipe before exiting", () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-json-"));
  const configRoot = join(root, "config", "maintainer-tui");
  const cacheRoot = join(root, "cache", "maintainer-tui");
  mkdirSync(configRoot, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });
  writeFileSync(
    join(configRoot, "config.json"),
    JSON.stringify({ roots: [], cloneRoot: root, app: "Warp", mode: "tab", command: null }),
  );
  writeFileSync(
    join(cacheRoot, "repos.json"),
    JSON.stringify({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      fetchedAt: Date.now(),
      viewer: "octocat",
      repos: Array.from({ length: 700 }, (_, index) =>
        repo({ nameWithOwner: `octocat/repository-${index}` }),
      ),
      attention: { reviewRequested: [], authored: [], assigned: [] },
    }),
  );

  const result = spawnSync(
    "/bin/sh",
    [
      "-c",
      `"$TASK_BUN" "$TASK_CLI" --json | "$TASK_BUN" -e 'const input = await Bun.stdin.text(); JSON.parse(input)'`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        TASK_BUN: process.execPath,
        TASK_CLI: join(import.meta.dir, "cli.tsx"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_CONFIG_HOME: join(root, "config"),
      },
    },
  );

  expect(result.status).toBe(0);
});

test("PR search arguments preserve the three GitHub inbox definitions", () => {
  const common = [
    "--state=open",
    "--archived=false",
    "--sort=updated",
    "--order=desc",
    "--limit=100",
    "--json",
    "repository,number,title,url,isDraft,updatedAt",
  ];

  expect(prSearchArgs("authored")).toEqual(["search", "prs", "--author=@me", ...common]);
  expect(prSearchArgs("assigned")).toEqual(["search", "prs", "--assignee=@me", ...common]);
  expect(prSearchArgs("reviewRequested")).toEqual([
    "search",
    "prs",
    "--review-requested=@me",
    ...common,
  ]);
  expect(SNAPSHOT_SCHEMA_VERSION).toBe(3);
});

test("prQueue puts review requests first, then each half by recency", () => {
  const pr = (repository: string, number: number, updatedAt: string): PrRef => ({
    repository,
    number,
    updatedAt,
    title: "",
    url: "",
    isDraft: false,
  });

  const queue = prQueue({
    // Deliberately the stalest PR in the set: someone else is still blocked on it.
    reviewRequested: [pr("acme/lib", 1, "2020-01-01T00:00:00Z")],
    authored: [pr("o/old", 2, "2026-01-01T00:00:00Z"), pr("o/fresh", 3, "2026-08-01T00:00:00Z")],
    assigned: [],
  });

  expect(queue.map((p) => p.repository)).toEqual(["acme/lib", "o/fresh", "o/old"]);
  expect(queue.map((p) => p.waitingOnReview)).toEqual([true, false, false]);
});

test("prQueue keeps authored, assigned, and review-requested tabs independent", () => {
  const pr = (repository: string, number: number, updatedAt: string): PrRef => ({
    repository,
    number,
    updatedAt,
    title: "",
    url: "",
    isDraft: false,
  });
  const overlap = pr("o/overlap", 1, "2026-07-01T00:00:00Z");
  const attention = {
    authored: [overlap, pr("o/authored-new", 2, "2026-08-01T00:00:00Z")],
    assigned: [overlap, pr("o/assigned-old", 3, "2026-01-01T00:00:00Z")],
    reviewRequested: [pr("o/review", 4, "2026-06-01T00:00:00Z")],
  };

  expect(prQueue(attention, "authored").map((pr) => pr.repository)).toEqual([
    "o/authored-new",
    "o/overlap",
  ]);
  expect(prQueue(attention, "assigned").map((pr) => pr.repository)).toEqual([
    "o/overlap",
    "o/assigned-old",
  ]);
  expect(prQueue(attention, "reviewRequested").map((pr) => pr.waitingOnReview)).toEqual([true]);
});

test("prQueue is empty when nothing is open", () => {
  expect(prQueue({ reviewRequested: [], authored: [], assigned: [] })).toEqual([]);
});

test("a submodule is found even though the walk stops at its parent repo", () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-sub-"));

  const parent = join(root, "mirae");
  execFileSync("git", ["init", "-q", parent]);
  execFileSync("git", [
    "-C",
    parent,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/mirae.git",
  ]);

  // The nested checkout is a repository in its own right; only .gitmodules says it is there.
  const nested = join(parent, "warm_alarm");
  execFileSync("git", ["init", "-q", nested]);
  execFileSync("git", [
    "-C",
    nested,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/warm_alarm.git",
  ]);
  writeFileSync(
    join(parent, ".gitmodules"),
    '[submodule "warm_alarm"]\n\tpath = warm_alarm\n\turl = https://github.com/acme/warm_alarm.git\n',
  );

  const found = scanRoots([root]);

  expect(found.get("acme/mirae")).toBe(parent);
  expect(found.get("acme/warm_alarm")).toBe(nested);
});

test("agentCommand keeps a seeded prompt to one line", () => {
  expect(agentCommand("claude")).toBe("claude");
  // The reply reaches the new shell through a file, so no newline can land inside the command —
  // an AppleScript string literal cannot span lines.
  const seeded = agentCommand("claude", "/tmp/it's a triage.md");
  expect(seeded).not.toContain("\n");
  expect(seeded).toBe(`claude "$(cat '/tmp/it'\\''s a triage.md')"`);
});

test("ownerRepo normalises every remote form", () => {
  expect(ownerRepo("git@github.com:AndrewDongminYoo/Bootstrap-Icons-Flutter.git")).toBe(
    "AndrewDongminYoo/Bootstrap-Icons-Flutter",
  );
  expect(ownerRepo("https://github.com/AndrewDongminYoo/purrfect.git")).toBe(
    "AndrewDongminYoo/purrfect",
  );
  expect(ownerRepo("https://github.com/AndrewDongminYoo/purrfect")).toBe(
    "AndrewDongminYoo/purrfect",
  );
  expect(ownerRepo("https://gitlab.com/x/y.git")).toBeNull();
});

test("scanRoots keys on the remote, and a plain subdirectory of a git root is not a clone", () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-scan-"));

  // An enclosing repository, exactly like ~/Development/01_personal on this machine.
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", [
    "-C",
    root,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/enclosing.git",
  ]);

  // A real clone whose directory name deliberately differs from its repo name.
  const clone = join(root, "bootstrap_icons");
  execFileSync("git", ["init", "-q", clone]);
  execFileSync("git", [
    "-C",
    clone,
    "remote",
    "add",
    "origin",
    "git@github.com:acme/Bootstrap-Icons-Flutter.git",
  ]);

  // A plain directory. `git -C` here would answer with the enclosing repo's remote.
  const plain = join(root, "not-a-repo");
  mkdirSync(plain);
  writeFileSync(join(plain, "README.md"), "no git here\n");

  const found = scanRoots([root]);

  expect(found.get("acme/bootstrap-icons-flutter")).toBe(clone);
  expect([...found.values()]).not.toContain(plain);
});

// checkoutState parses git's own output, so it is covered against a real repository rather than
// a fixture string: the header shape is git's to change, not ours.
test("checkoutState reads branch, tracking and dirty files from a real repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maintainer-state-"));
  execFileSync("git", ["init", "-q", "-b", "trunk", dir]);

  // No commits yet: git words the header differently, and there is no upstream.
  expect(await checkoutState(dir)).toEqual({
    branch: "trunk",
    dirty: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    tracked: false,
  });

  writeFileSync(join(dir, "a.txt"), "x\n");
  execFileSync("git", ["-C", dir, "add", "a.txt"]);
  writeFileSync(join(dir, "a.txt"), "changed\n");
  writeFileSync(join(dir, "b.txt"), "untracked\n");
  expect(await checkoutState(dir)).toMatchObject({
    dirty: 2,
    staged: 1,
    modified: 1,
    untracked: 1,
  });
});

const config = (over: Partial<Config>): Config => ({
  roots: [],
  cloneRoot: "/tmp",
  app: "Warp",
  mode: "tab",
  command: null,
  agent: "claude",
  ...over,
});

test("Warp honours mode through its URI scheme", () => {
  expect(launchArgv("/r/p", config({ app: "Warp", mode: "tab" }))).toEqual([
    "open",
    "warp://action/new_tab?path=%2Fr%2Fp",
  ]);
  expect(launchArgv("/r/p", config({ app: "Warp", mode: "window" }))).toEqual([
    "open",
    "warp://action/new_window?path=%2Fr%2Fp",
  ]);
});

test("Xcode and Android Studio open the target the IDE actually wants", () => {
  const repo = mkdtempSync(join(tmpdir(), "maintainer-ide-"));

  // Bare repo: nothing to prefer, so the checkout itself is the target.
  expect(xcodeTarget(repo)).toBe(repo);
  expect(androidTarget(repo)).toBe(repo);

  // Cross-platform layout: the native projects sit one level down.
  mkdirSync(join(repo, "ios"));
  mkdirSync(join(repo, "android"));
  mkdirSync(join(repo, "ios", "Runner.xcodeproj"));
  expect(xcodeTarget(repo)).toBe(join(repo, "ios", "Runner.xcodeproj"));
  expect(androidTarget(repo)).toBe(join(repo, "android"));

  // A workspace outranks the project it contains.
  mkdirSync(join(repo, "ios", "Runner.xcworkspace"));
  expect(xcodeTarget(repo)).toBe(join(repo, "ios", "Runner.xcworkspace"));
});

test("launchArgv picks a per-app strategy and only terminals get the command", () => {
  expect(launchArgv("/r/p", config({ app: "Warp" }))).toEqual([
    "open",
    "warp://action/new_tab?path=%2Fr%2Fp",
  ]);

  expect(launchArgv("/r/p", config({ app: "Visual Studio Code" }))).toEqual([
    "open",
    "-a",
    "Visual Studio Code",
    "/r/p",
  ]);

  const iterm = launchArgv("/r/p", config({ app: "iTerm", command: "claude" }));
  expect(iterm[0]).toBe("osascript");
  expect(iterm[2]).toContain("create tab with default profile");
  expect(iterm[2]).toContain("cd '/r/p' && claude");
});

test("paths with quotes survive shell and AppleScript quoting", () => {
  const argv = launchArgv("/r/it's a repo", config({ app: "iTerm", command: 'say "hi"' }));
  // Two escaping layers stack here. The shell layer closes, escapes and reopens the quote
  // (`'\''`); the AppleScript layer then doubles that backslash so its own string literal
  // yields `'\''` back at runtime. Asserting the source form catches either layer going missing.
  expect(argv[2]).toContain(`cd '/r/it'\\\\''s a repo'`);
  expect(argv[2]).toContain('say \\"hi\\"');
});

// Asserting the generated string only proves the string. `osacompile` parses it for real —
// and unlike `osascript`, it never runs it, so no terminal windows appear during a test run.
test.skipIf(process.platform !== "darwin")("generated AppleScript actually compiles", () => {
  const out = join(mkdtempSync(join(tmpdir(), "maintainer-osa-")), "t.scpt");

  // The seeded agent command is the fragile one: it carries a `$( )` and a quoted path into a
  // string literal that cannot span lines.
  const commands = ['say "hi"', agentCommand("claude", "/tmp/it's a triage.md")];

  for (const app of ["iTerm", "Terminal"]) {
    for (const mode of ["tab", "window"] as const) {
      for (const command of commands) {
        const argv = launchArgv("/r/it's a repo", config({ app, mode, command }));
        expect(() => execFileSync("osacompile", ["-o", out, "-e", argv[2] ?? ""])).not.toThrow();
      }
    }
  }

  expect(() =>
    execFileSync("osacompile", ["-o", out, "-e", 'tell application "iTerm" activate end']),
  ).toThrow();
});
