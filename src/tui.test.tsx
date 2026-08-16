import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import * as React from "react";

import { ThemeProvider } from "@/providers/theme-provider";

import {
  App,
  checkoutSummary,
  matchesQuery,
  nameColumnWidth,
  prLabel,
  tags,
  withoutOwner,
} from "./app.tsx";
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

const rowFor = (screen: string, name: string): string =>
  screen.split("\n").find((line) => line.includes(name)) ?? "";

test("the listing renders with its signal columns", async () => {
  const screen = await frame();
  const row = rowFor(screen, "live");

  expect(row).toContain("⚠ 2");
  expect(row).toContain("3 PR");
  expect(row).toContain("not cloned");
});

// The row carries the short name and the detail pane carries the full one — the listing is where
// the owner is seventeen wasted cells, the detail pane is where the repo has to be unambiguous.
test("the owner is dropped from the row but kept in the detail pane", async () => {
  const screen = await frame();

  expect(rowFor(screen, "▸")).not.toContain("octocat/");
  expect(screen).toContain("repo : octocat/live");
});

test("archived repos are out of the listing and out of the count", async () => {
  const screen = await frame();

  expect(screen).not.toContain("retired");
  expect(screen).toContain("3/4 repos");
});

// A fork inherits upstream's Dependabot alerts, so the ⚠ column on one is not the viewer's debt.
// Saying so on the row is the whole point of the tag.
//
// This only reaches the two-tag case. The widest row a repo can produce also carries `archived`,
// and archived repos are hidden until `x` — which this harness cannot press. So the 28-cell case
// is covered for composition below and was measured by hand against a 100-column frame; a change
// to the column widths can still squeeze it without failing anything here.
test("a fork says so on its row, untruncated", async () => {
  const screen = await frame();
  const row = screen.split("\n").find((line) => line.includes("borrowed"));

  expect(row).toContain("fork · not cloned");
  expect(row).not.toContain("...");
});

// The PR panel opens on `p`, which this harness cannot press, so its rows are covered here and
// its render was checked by hand against a 100-column frame — both the populated and empty paths.
test("a queued PR drops the owner only when it is the viewer's own", () => {
  const pr = (repository: string) => ({
    repository,
    number: 77,
    title: "",
    url: "",
    isDraft: false,
    updatedAt: "2026-08-01T00:00:00Z",
    waitingOnReview: false,
  });

  expect(prLabel(pr("octocat/party-os"), "octocat")).toBe("party-os#77");
  expect(prLabel(pr("acme/shared-lib"), "octocat")).toBe("acme/shared-lib#77");
  // A repo whose name merely starts with the viewer's login is not owned by them.
  expect(prLabel(pr("octocat-labs/thing"), "octocat")).toBe(
    "octocat-labs/thing#77",
  );
});

test("the listing shortens the same names the PR panel does", () => {
  expect(withoutOwner("octocat/party-os", "octocat")).toBe("party-os");
  expect(withoutOwner("acme/shared-lib", "octocat")).toBe("acme/shared-lib");
  expect(withoutOwner("octocat-labs/thing", "octocat")).toBe(
    "octocat-labs/thing",
  );
});

// `/` is a mode, and this harness cannot press it, so the predicate is covered here. The mode
// itself was driven against a pty: typing `/catfood` as one chunk narrows 94 rows to 1, and the
// characters after the slash do not run as commands.
test("search matches any part of owner/name, case-insensitively", () => {
  const target = repo("octocat/Party-OS");

  expect(matchesQuery(target, "party")).toBe(true);
  expect(matchesQuery(target, "OCTO")).toBe(true);
  expect(matchesQuery(target, "  party  ")).toBe(true);
  expect(matchesQuery(target, "")).toBe(true);
  expect(matchesQuery(target, "nothing")).toBe(false);
});

// The detail pane reads this for the focused repo only. "since last fetch" has to survive edits:
// git compares against the stored remote ref, so a stale checkout reports nothing behind while
// origin has moved, and dropping the qualifier turns that into a false all-clear.
test("the working-copy summary says where its numbers came from", () => {
  const state = {
    branch: "main",
    dirty: 0,
    ahead: 0,
    behind: 0,
    tracked: true,
  };

  expect(checkoutSummary(state)).toBe("main · clean");
  expect(checkoutSummary({ ...state, dirty: 3 })).toBe("main · 3 changed");
  expect(checkoutSummary({ ...state, ahead: 10 })).toBe(
    "main · 10 unpushed · since last fetch",
  );
  expect(checkoutSummary({ ...state, ahead: 1, behind: 2 })).toBe(
    "main · 1 unpushed · 2 behind · since last fetch",
  );
  // No upstream makes ahead/behind meaningless rather than zero, so they are not claimed.
  expect(checkoutSummary({ ...state, tracked: false })).toBe(
    "main · no upstream",
  );
  expect(checkoutSummary(null)).toBe("");
});

// A wide terminal was still truncating names against a column fixed at 30, with half the screen
// empty beside it.
test("the name column follows the terminal, up to the longest name present", () => {
  // Room to spare: the column stops at what the names need rather than filling.
  expect(nameColumnWidth(32, 215)).toBe(32);
  expect(nameColumnWidth(40, 215)).toBe(40);
  // Not enough room: it gives back what it must, leaving the tag column its 28.
  expect(nameColumnWidth(40, 100)).toBe(38);
  // Narrow enough that the tags have to give way instead.
  expect(nameColumnWidth(40, 70)).toBe(18);
});

test("tags compose in a fixed order", () => {
  const flagged = repo("octocat/flagged", { isFork: true, isArchived: true });

  expect(tags(flagged, undefined)).toBe("fork · archived · not cloned");
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
  expect(rowFor(screen, "a-deliberatel")).toMatch(
    /a-deliberatel.*\.\.\..*name/,
  );
});
