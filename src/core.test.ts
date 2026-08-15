import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import type { Config } from "./config.ts";
import { needsRelease, sortRepos, type Repo } from "./github.ts";
import {
  androidTarget,
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
    sortRepos([quietButRecent, busyButOld, busier, stale], "activity").map(
      (r) => r.nameWithOwner,
    ),
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

test("needsRelease only fires when the branch moved after the last release", () => {
  expect(needsRelease(repo({ latestRelease: null }))).toBe(false);
  expect(
    needsRelease(
      repo({
        pushedAt: "2026-05-01T00:00:00Z",
        latestRelease: { tagName: "v1", createdAt: "2026-01-01T00:00:00Z" },
      }),
    ),
  ).toBe(true);
  expect(
    needsRelease(
      repo({
        pushedAt: "2026-01-01T00:00:00Z",
        latestRelease: { tagName: "v1", createdAt: "2026-05-01T00:00:00Z" },
      }),
    ),
  ).toBe(false);
});

test("ownerRepo normalises every remote form", () => {
  expect(
    ownerRepo("git@github.com:AndrewDongminYoo/Bootstrap-Icons-Flutter.git"),
  ).toBe("AndrewDongminYoo/Bootstrap-Icons-Flutter");
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
  const argv = launchArgv(
    "/r/it's a repo",
    config({ app: "iTerm", command: 'say "hi"' }),
  );
  // Two escaping layers stack here. The shell layer closes, escapes and reopens the quote
  // (`'\''`); the AppleScript layer then doubles that backslash so its own string literal
  // yields `'\''` back at runtime. Asserting the source form catches either layer going missing.
  expect(argv[2]).toContain(`cd '/r/it'\\\\''s a repo'`);
  expect(argv[2]).toContain('say \\"hi\\"');
});

// Asserting the generated string only proves the string. `osacompile` parses it for real —
// and unlike `osascript`, it never runs it, so no terminal windows appear during a test run.
test.skipIf(process.platform !== "darwin")(
  "generated AppleScript actually compiles",
  () => {
    const out = join(mkdtempSync(join(tmpdir(), "maintainer-osa-")), "t.scpt");

    for (const app of ["iTerm", "Terminal"]) {
      for (const mode of ["tab", "window"] as const) {
        const argv = launchArgv(
          "/r/it's a repo",
          config({ app, mode, command: 'say "hi"' }),
        );
        expect(() =>
          execFileSync("osacompile", ["-o", out, "-e", argv[2] ?? ""]),
        ).not.toThrow();
      }
    }

    expect(() =>
      execFileSync("osacompile", [
        "-o",
        out,
        "-e",
        'tell application "iTerm" activate end',
      ]),
    ).toThrow();
  },
);
