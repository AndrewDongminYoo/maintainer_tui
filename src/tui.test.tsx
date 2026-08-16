import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import * as React from "react";

import { ThemeProvider } from "@/providers/theme-provider";

import { App, tags } from "./app.tsx";
import type { Config } from "./config.ts";
import type { Repo, Snapshot } from "./github.ts";

/**
 * Frame-level cover for the OpenTUI render path.
 *
 * The byte stream a terminal receives is a cell-by-cell diff, so reading a pty capture back is
 * hopeless — a label that changed in its second half never appears whole again. `captureCharFrame`
 * gives the screen as it reads instead.
 *
 * Keys are not driven here: `mockInput` delivers by emitting on `renderer.stdin` and the
 * `useKeyboard` subscription never sees it, so a keypress test would pass vacuously. Key handling
 * was verified by hand against a pty; if that gap ever matters enough, fix the harness rather
 * than asserting on the byte stream.
 */

const repo = (nameWithOwner: string, over: Partial<Repo> = {}): Repo => ({
  nameWithOwner,
  url: "",
  isPrivate: false,
  isArchived: false,
  isFork: false,
  pushedAt: "2026-01-01T00:00:00Z",
  stars: 0,
  forks: 0,
  watchers: 7,
  language: "Dart",
  openIssues: 0,
  openPrs: 3,
  lastActivityAt: null,
  vulnCount: 2,
  latestRelease: null,
  ...over,
});

const snapshot: Snapshot = {
  fetchedAt: Date.now(),
  viewer: "octocat",
  repos: [
    repo("octocat/live"),
    repo("octocat/retired", { isArchived: true }),
    repo("octocat/borrowed", { isFork: true }),
    repo("octocat/a-deliberately-overlong-repository-name"),
  ],
  attention: { reviewRequested: [], authored: [] },
};

// No roots, so scanRoots never walks the real filesystem.
const config: Config = {
  roots: [],
  cloneRoot: "/tmp",
  app: "Warp",
  mode: "tab",
  command: null,
  agent: "claude",
};

async function frame(): Promise<string> {
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={snapshot} />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );
  await setup.flush();
  return setup.captureCharFrame();
}

test("the listing renders with its signal columns", async () => {
  const screen = await frame();

  expect(screen).toContain("octocat/live");
  expect(screen).toContain("⚠ 2");
  expect(screen).toContain("3 PR");
  expect(screen).toContain("not cloned");
});

test("archived repos are out of the listing and out of the count", async () => {
  const screen = await frame();

  expect(screen).not.toContain("octocat/retired");
  expect(screen).toContain("3/4 repos");
});

// A fork inherits upstream's Dependabot alerts, so the ⚠ column on one is not the viewer's debt.
// Saying so on the row is the whole point of the tag. The tag column is last, so it is also what
// gets squeezed — an ellipsis here means the flag the user asked for is the first thing to go.
test("a fork says so on its row, untruncated", async () => {
  const screen = await frame();
  const row = screen
    .split("\n")
    .find((line) => line.includes("octocat/borrowed"));

  expect(row).toContain("· fork · remote");
  expect(row).not.toContain("...");
});

// The widest a row can get. Composition is asserted here; that it still fits is asserted by the
// row above, which carries the same column budget.
test("tags compose in a fixed order", () => {
  const flagged = repo("octocat/flagged", { isFork: true, isArchived: true });

  expect(tags(flagged, undefined)).toBe("· fork · archived · remote");
  expect(tags(repo("octocat/plain"), "/somewhere")).toBe("");
});

// ◉ measures the one cell it draws; the eye emoji it replaced measured one and drew two, which
// overwrote the watcher count in Warp.
test("the watcher mark leaves its count readable", async () => {
  expect(await frame()).toContain("◉7");
});

test("an overlong name is truncated rather than wrapped onto the next row", async () => {
  const screen = await frame();

  expect(screen).not.toContain("a-deliberately-overlong-repository-name");
  expect(screen).toMatch(/octocat\/a.*\.\.\..*name/);
});
