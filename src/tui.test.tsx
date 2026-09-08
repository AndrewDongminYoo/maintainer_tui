import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { CliRenderEvents, parseKeypress } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import * as React from "react";

import { ThemeProvider } from "@/providers/theme-provider";

import {
  App,
  checkoutSummary,
  matchesQuery,
  nameColumnWidth,
  prLabel,
  prLabelWidth,
  semanticSelectionPayload,
  selectionAfterOpen,
  selectionAfterRefresh,
  tags,
  withoutOwner,
} from "./app.tsx";
import type { Config } from "./config.ts";
import { SNAPSHOT_SCHEMA_VERSION, type PrRef, type Repo, type Snapshot } from "./github.ts";
import type { CheckoutState } from "./local.ts";

/**
 * Frame-level cover for the OpenTUI render path.
 *
 * The byte stream a terminal receives is a cell-by-cell diff, so reading a pty capture back is
 * hopeless — a label that changed in its second half never appears whole again. `captureCharFrame`
 * gives the screen as it reads instead.
 *
 * `mockInput` is not used for keys: it delivers by emitting on `renderer.stdin` and the
 * `useKeyboard` subscription never sees it, so a keypress test there would pass vacuously. Tests
 * that need a visible key path call `renderer.keyInput.processParsedKey` directly.
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

const attentionPr = (
  repository: string,
  number: number,
  title: string,
  updatedAt: string,
): PrRef => ({
  repository,
  number,
  title,
  updatedAt,
  url: "",
  isDraft: false,
});

const snapshot: Snapshot = {
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  fetchedAt: Date.now(),
  viewer: "octocat",
  repos: [
    repo("octocat/live"),
    repo("octocat/retired", { isArchived: true }),
    repo("octocat/borrowed", { isFork: true }),
    repo("octocat/a-deliberately-overlong-repository-name"),
  ],
  attention: { reviewRequested: [], authored: [], assigned: [] },
};

const navigationSnapshot: Snapshot = {
  ...snapshot,
  repos: Array.from({ length: 20 }, (_, index) =>
    repo(`octocat/repo-${String(index).padStart(2, "0")}`, {
      pushedAt: new Date(Date.UTC(2026, 0, 20 - index)).toISOString(),
    }),
  ),
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

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

test("the listing renders with its signal columns", async () => {
  const screen = await frame();
  const row = rowFor(screen, "live");

  expect(row).toContain("⚠ 2");
  expect(row).toContain("3 PR");
  expect(row).toContain("not cloned");
});

test("the listing marks unavailable vulnerability data as unknown", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={config}
        initial={{
          ...snapshot,
          repos: [repo("octocat/unavailable", { vulnCount: null })],
        }}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    expect(rowFor(setup.captureCharFrame(), "unavailable")).toContain("⚠ ?");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("the PR, release, and updated signals have distinct spacing", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={config}
        initial={{
          ...snapshot,
          repos: [
            repo("octocat/signals", {
              openPrs: 12,
              lastActivityAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
              latestRelease: {
                tagName: "v1",
                createdAt: "2026-01-01T00:00:00Z",
                defaultBranchAheadBy: 1,
              },
            }),
          ],
        }}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    expect(rowFor(setup.captureCharFrame(), "signals")).toContain("12 PR  bump  3d");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("an incomparable release is not described as up to date", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={config}
        initial={{
          ...snapshot,
          repos: [
            repo("octocat/live", {
              latestRelease: {
                tagName: "v1",
                createdAt: "2026-01-01T00:00:00Z",
                defaultBranchAheadBy: null,
              },
            }),
          ],
        }}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    const screen = setup.captureCharFrame();
    expect(screen).toContain("v1 · comparison unavailable");
    expect(screen).not.toContain("up to date");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("the default footer keeps focused and global commands discoverable", async () => {
  const screen = await frame();

  expect(screen).toContain("O GitHub · y copy");
  expect(screen).toContain("g agent · p PRs");
  expect(screen).toContain("x archived");
  expect(screen).toContain("r refresh");
});

test("an empty listing footer does not render an empty action separator", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={{ ...snapshot, repos: [] }} />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    const screen = setup.captureCharFrame();
    expect(screen).toContain("no matching repos · r refresh");
    expect(screen).not.toContain(" ·  · ");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("the detail footer keeps its height while working-copy state resolves", async () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-footer-"));
  const checkout = join(root, "live");
  execFileSync("git", ["init", "-q", "-b", "main", checkout]);
  execFileSync("git", [
    "-C",
    checkout,
    "remote",
    "add",
    "origin",
    "https://github.com/octocat/live.git",
  ]);
  let resolveCheckout: (state: CheckoutState) => void = () => undefined;
  const nextCheckout = new Promise<CheckoutState>((resolve) => {
    resolveCheckout = resolve;
  });

  const setup = await testRender(
    <ThemeProvider>
      <App
        config={{ ...config, roots: [root] }}
        initial={{ ...snapshot, repos: [repo("octocat/live")] }}
        readCheckout={() => nextCheckout}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    let before = "";
    await setup.renderOnce();
    before = setup.captureCharFrame();

    await React.act(async () => {
      resolveCheckout({
        branch: "main",
        dirty: 1,
        staged: 1,
        modified: 1,
        untracked: 0,
        ahead: 0,
        behind: 0,
        tracked: false,
      });
      await Promise.resolve();
      await setup.renderOnce();
    });
    const after = setup.captureCharFrame();

    expect(before).not.toContain("working");
    expect(before).not.toContain("Branch main");
    expect(rowFor(after, "octocat/live")).not.toBe("");
    expect(after).toContain("Branch main");
    expect(after).toContain("1 staged · 1 modified");
    expect(before.split("\n").indexOf(rowFor(before, "octocat/live"))).toBe(
      after.split("\n").indexOf(rowFor(after, "octocat/live")),
    );
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("O opens the focused repository on GitHub even when another repository is selected", async () => {
  const opened: string[] = [];
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={config}
        initial={{
          ...snapshot,
          repos: [
            repo("octocat/selected", { url: "https://github.com/octocat/selected" }),
            repo("acme/focused", { url: "https://github.com/acme/focused" }),
          ],
        }}
        openExternal={async (url) => {
          opened.push(url);
        }}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress(" ")!);
      setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[B")!);
    });
    await setup.flush();
    await React.act(async () => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("O")!);
      await Promise.resolve();
    });
    await setup.flush();

    expect(opened).toEqual(["https://github.com/acme/focused"]);
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("y copies the focused canonical owner/name and shows feedback", async () => {
  const copied: string[] = [];
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={config}
        initial={{ ...snapshot, repos: [repo("octocat/live")] }}
        copyText={async (value) => {
          copied.push(value);
        }}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    await React.act(async () => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("y")!);
      await Promise.resolve();
    });
    await setup.flush();

    expect(copied).toEqual(["octocat/live"]);
    expect(setup.captureCharFrame()).toContain("copied octocat/live");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("copy errors keep their reason visible in the fixed footer", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={config}
        initial={{ ...snapshot, repos: [repo("octocat/live")] }}
        copyText={async () => {
          throw new Error("clipboard unavailable\naccess denied");
        }}
      />
    </ThemeProvider>,
    { width: 20, height: 20 },
  );

  try {
    await setup.flush();
    await React.act(async () => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("y")!);
      await Promise.resolve();
    });
    await setup.flush();

    const screen = setup.captureCharFrame();
    expect(screen).toContain("✗");
    expect(screen).toContain("clipbo");
    expect(screen).toContain("access denied");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("End focuses the last repository in the current listing", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={navigationSnapshot} />
    </ThemeProvider>,
    { width: 100, height: 20 },
  );

  try {
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[F")!);
    });
    await setup.flush();

    expect(rowFor(setup.captureCharFrame(), "repo-19")).toContain("▸");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("Home focuses the first repository", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={navigationSnapshot} />
    </ThemeProvider>,
    { width: 100, height: 20 },
  );

  try {
    await setup.flush();
    React.act(() => {
      for (let index = 0; index < 6; index += 1) {
        setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[B")!);
      }
      setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[H")!);
    });
    await setup.flush();

    expect(rowFor(setup.captureCharFrame(), "repo-00")).toContain("▸");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("scrolling the repository cursor commits the focused row and viewport together", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={navigationSnapshot} />
    </ThemeProvider>,
    { width: 100, height: 20 },
  );

  try {
    await setup.flush();
    for (let count = 0; count < 4; count += 1) {
      React.act(() => {
        setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[B")!);
      });
      await setup.flush();
    }

    const frames: { cellsUpdated: number; screen: string }[] = [];
    setup.renderer.on(CliRenderEvents.FRAME, () => {
      frames.push({
        cellsUpdated: setup.getNativeStats().cellsUpdated,
        screen: setup.captureCharFrame(),
      });
    });
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[B")!);
    });
    await setup.flush();

    const screen = setup.captureCharFrame();
    expect(frames.filter((frame) => frame.cellsUpdated > 0)).toHaveLength(1);
    for (const frame of frames) {
      expect(rowFor(frame.screen, "repo-01")).not.toBe("");
      expect(rowFor(frame.screen, "repo-05")).toContain("▸");
    }
    expect(rowFor(screen, "repo-01")).not.toBe("");
    expect(rowFor(screen, "repo-05")).toContain("▸");
    expect(rowFor(screen, "repo-01").trimEnd()).toEndWith("█");
    expect(rowFor(screen, "repo-03").trimEnd()).toEndWith("│");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("held repository navigation preserves every move inside the rendered viewport", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={navigationSnapshot} />
    </ThemeProvider>,
    { width: 100, height: 20 },
  );

  try {
    await setup.flush();
    React.act(() => {
      for (let count = 0; count < 8; count += 1) {
        setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[B")!);
      }
    });
    await setup.flush();

    const screen = setup.captureCharFrame();
    expect(rowFor(screen, "repo-04")).not.toBe("");
    expect(rowFor(screen, "repo-08")).toContain("▸");

    React.act(() => {
      for (let count = 0; count < 4; count += 1) {
        setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[A")!);
      }
    });
    await setup.flush();

    expect(rowFor(setup.captureCharFrame(), "repo-04")).toContain("▸");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("the repository list moves its focused row with the mouse wheel", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={navigationSnapshot} />
    </ThemeProvider>,
    { width: 100, height: 20 },
  );

  try {
    await setup.flush();
    await React.act(async () => {
      await setup.mockMouse.scroll(1, 4, "down");
    });
    await setup.flush();

    expect(rowFor(setup.captureCharFrame(), "repo-01")).toContain("▸");

    await React.act(async () => {
      await setup.mockMouse.scroll(1, 4, "up");
    });
    await setup.flush();

    expect(rowFor(setup.captureCharFrame(), "repo-00")).toContain("▸");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("resizing normalizes the rendered repository viewport around the focused row", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={navigationSnapshot} />
    </ThemeProvider>,
    { width: 100, height: 20 },
  );

  try {
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[F")!);
    });
    await setup.flush();
    React.act(() => {
      setup.renderer.resize(100, 18);
    });
    await setup.flush();

    const screen = setup.captureCharFrame();
    expect(rowFor(screen, "repo-17")).not.toBe("");
    expect(rowFor(screen, "repo-19")).toContain("▸");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("the fixed repository viewport leaves the detail footer below the fifth row", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={navigationSnapshot} />
    </ThemeProvider>,
    { width: 100, height: 20 },
  );

  try {
    await setup.flush();
    const rows = setup.captureCharFrame().slice(0, -1).split("\n");
    const finalRepositoryRow = rows.indexOf(rowFor(rows.join("\n"), "repo-04"));
    const detailRow = rows.indexOf(rowFor(rows.join("\n"), "repo      :"));

    expect(rows).toHaveLength(20);
    expect(finalRepositoryRow).toBeLessThan(detailRow);
    expect(rows[finalRepositoryRow + 1]).toContain("─");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a narrow terminal keeps the repository viewport above the footer", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={navigationSnapshot} />
    </ThemeProvider>,
    { width: 40, height: 20 },
  );

  try {
    await setup.flush();
    const rows = setup.captureCharFrame().slice(0, -1).split("\n");
    const finalRepositoryRow = rows.indexOf(rowFor(rows.join("\n"), "repo-04"));

    expect(finalRepositoryRow).toBeGreaterThanOrEqual(0);
    expect(rows[finalRepositoryRow + 1]).toContain("─");
    expect(rows.join("\n")).toContain("r refresh");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("PageDown moves the cursor by half of the repository viewport", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={navigationSnapshot} />
    </ThemeProvider>,
    { width: 100, height: 20 },
  );

  try {
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[6~")!);
    });
    await setup.flush();

    expect(rowFor(setup.captureCharFrame(), "repo-03")).toContain("▸");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("PageUp moves the cursor by half of the repository viewport", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={navigationSnapshot} />
    </ThemeProvider>,
    { width: 100, height: 20 },
  );

  try {
    await setup.flush();
    React.act(() => {
      for (let index = 0; index < 6; index += 1) {
        setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[B")!);
      }
      setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[5~")!);
    });
    await setup.flush();

    expect(rowFor(setup.captureCharFrame(), "repo-03")).toContain("▸");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("open removes successes while keeping failures and uncloned repos selected", () => {
  const selected = new Set(["octocat/opened", "octocat/failed", "octocat/missing"]);

  expect(
    selectionAfterOpen(
      selected,
      [
        { nameWithOwner: "octocat/opened", path: "/repos/opened" },
        { nameWithOwner: "octocat/failed", path: "/repos/failed" },
        { nameWithOwner: "octocat/missing" },
      ],
      [
        { path: "/repos/opened", ok: true },
        { path: "/repos/failed", ok: false },
      ],
    ),
  ).toEqual(new Set(["octocat/failed", "octocat/missing"]));
});

test("refresh drops selections for repositories no longer in the snapshot", () => {
  expect(
    selectionAfterRefresh(new Set(["octocat/live", "octocat/deleted"]), [
      { nameWithOwner: "octocat/live" },
    ]),
  ).toEqual(new Set(["octocat/live"]));
});

test("refresh uses the supplied snapshot boundary and persists its result", async () => {
  const refreshed: Snapshot = {
    ...snapshot,
    fetchedAt: snapshot.fetchedAt + 1,
    repos: [repo("octocat/refreshed")],
  };
  const persisted: Snapshot[] = [];
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={config}
        initial={snapshot}
        loadSnapshot={async () => refreshed}
        persistSnapshot={(next) => {
          persisted.push(next as Snapshot);
        }}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    await React.act(async () => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("r")!);
      await Promise.resolve();
    });
    await setup.flush();

    expect(setup.captureCharFrame()).toContain("refreshed");
    expect(persisted).toEqual([refreshed]);
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a stale refresh completion cannot replace the latest visible and persisted state", async () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-refresh-"));
  const latestPath = join(root, "latest-checkout");
  const stalePath = join(root, "stale-checkout");
  const requests = [deferred<Snapshot>(), deferred<Snapshot>()];
  let requestIndex = 0;
  const persisted: Snapshot[] = [];
  const selectedRepo = repo("octocat/selected");
  const latest: Snapshot = {
    ...snapshot,
    fetchedAt: snapshot.fetchedAt + 2,
    repos: [selectedRepo, repo("octocat/latest-only")],
  };
  const stale: Snapshot = {
    ...snapshot,
    fetchedAt: snapshot.fetchedAt + 1,
    repos: [repo("octocat/stale-only")],
  };
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={{ ...config, roots: [root] }}
        initial={{ ...snapshot, repos: [selectedRepo] }}
        loadSnapshot={() => requests[requestIndex++]!.promise}
        persistSnapshot={(next) => {
          persisted.push(next as Snapshot);
        }}
        readCheckout={() => new Promise<CheckoutState>(() => undefined)}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress(" ")!);
      setup.renderer.keyInput.processParsedKey(parseKeypress("r")!);
      setup.renderer.keyInput.processParsedKey(parseKeypress("r")!);
    });
    execFileSync("git", ["init", "-q", "-b", "main", latestPath]);
    execFileSync("git", [
      "-C",
      latestPath,
      "remote",
      "add",
      "origin",
      "https://github.com/octocat/selected.git",
    ]);

    await React.act(async () => {
      requests[1]!.resolve(latest);
      await requests[1]!.promise;
    });
    await setup.flush();
    renameSync(latestPath, stalePath);
    await React.act(async () => {
      requests[0]!.resolve(stale);
      await requests[0]!.promise;
    });
    await setup.flush();

    const screen = setup.captureCharFrame();
    expect(screen).toContain("latest-only");
    expect(screen).not.toContain("stale-only");
    expect(screen).toContain("1 selected");
    expect(screen).toContain("latest-checkou");
    expect(screen).not.toContain("stale-checkout");
    expect(screen).not.toContain("querying GitHub");
    expect(persisted).toEqual([latest]);
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a stale refresh success cannot clear the latest refresh error", async () => {
  const requests = [deferred<Snapshot>(), deferred<Snapshot>()];
  let requestIndex = 0;
  const persisted: Snapshot[] = [];
  const stale: Snapshot = {
    ...snapshot,
    fetchedAt: snapshot.fetchedAt + 1,
    repos: [repo("octocat/stale-only")],
  };
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={config}
        initial={snapshot}
        loadSnapshot={() => requests[requestIndex++]!.promise}
        persistSnapshot={(next) => {
          persisted.push(next as Snapshot);
        }}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("r")!);
      setup.renderer.keyInput.processParsedKey(parseKeypress("r")!);
    });

    await React.act(async () => {
      requests[1]!.reject(new Error("latest refresh failed"));
      await requests[1]!.promise.catch(() => undefined);
    });
    await setup.flush();
    await React.act(async () => {
      requests[0]!.resolve(stale);
      await requests[0]!.promise;
    });
    await setup.flush();

    const screen = setup.captureCharFrame();
    expect(screen).toContain("latest refresh failed");
    expect(screen).not.toContain("stale-only");
    expect(persisted).toEqual([]);
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("clone uses the supplied command boundary and renders the cloned path", async () => {
  const clonedPath = "/tmp/cloned-by-boundary";
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={config}
        initial={{ ...snapshot, repos: [repo("octocat/to-clone")] }}
        cloneRepository={async () => clonedPath}
        readCheckout={() => new Promise<CheckoutState>(() => undefined)}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    await React.act(async () => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("c")!);
      await Promise.resolve();
    });
    await setup.flush();

    expect(setup.captureCharFrame()).toContain(clonedPath);
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("repeated clone input cannot duplicate an in-flight repository clone", async () => {
  const firstClone = deferred<string>();
  let firstAttempts = 0;
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={config}
        initial={{
          ...snapshot,
          repos: [repo("octocat/first"), repo("octocat/second")],
        }}
        cloneRepository={(nameWithOwner) => {
          if (nameWithOwner === "octocat/first") {
            firstAttempts += 1;
            if (firstAttempts > 1) throw new Error("duplicate clone invocation");
            return firstClone.promise;
          }
          return Promise.resolve("/tmp/cloned-second");
        }}
        readCheckout={() => new Promise<CheckoutState>(() => undefined)}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("c")!);
      setup.renderer.keyInput.processParsedKey(parseKeypress("c")!);
    });
    await setup.flush();

    const pending = setup.captureCharFrame();
    expect(pending).toContain("cloning octocat/first (1/1)");
    expect(pending).not.toContain("duplicate clone invocation");

    await React.act(async () => {
      firstClone.resolve("/tmp/cloned-first");
      await firstClone.promise;
    });
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[B")!);
    });
    await setup.flush();
    await React.act(async () => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("c")!);
      await Promise.resolve();
    });
    await setup.flush();

    expect(setup.captureCharFrame()).toContain("/tmp/cloned-second");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("a failed clone releases the in-flight guard for a retry", async () => {
  let attempt = 0;
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={config}
        initial={{ ...snapshot, repos: [repo("octocat/retry-clone")] }}
        cloneRepository={() => {
          attempt += 1;
          return attempt === 1
            ? Promise.reject(new Error("first clone failed"))
            : Promise.resolve("/tmp/cloned-after-retry");
        }}
        readCheckout={() => new Promise<CheckoutState>(() => undefined)}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    await React.act(async () => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("c")!);
      await Promise.resolve();
    });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("first clone failed");

    await React.act(async () => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("c")!);
      await Promise.resolve();
    });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("/tmp/cloned-after-retry");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("agent triage runs selected repositories sequentially and reports uncloned repositories", async () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-agent-batch-"));
  const firstPath = join(root, "first");
  const secondPath = join(root, "second");
  for (const [path, nameWithOwner] of [
    [firstPath, "octocat/first"],
    [secondPath, "octocat/second"],
  ] as const) {
    execFileSync("git", ["init", "-q", "-b", "main", path]);
    execFileSync("git", [
      "-C",
      path,
      "remote",
      "add",
      "origin",
      `https://github.com/${nameWithOwner}.git`,
    ]);
  }
  const runs = [deferred<string>(), deferred<string>()];
  const startedPaths: string[] = [];
  const startedPrompts: string[] = [];
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={{ ...config, roots: [root] }}
        initial={{
          ...snapshot,
          repos: [repo("octocat/first"), repo("octocat/second"), repo("octocat/missing")],
        }}
        startAgent={(_config, path, prompt) => {
          const run = runs[startedPaths.length]!;
          startedPaths.push(path);
          startedPrompts.push(prompt);
          return { done: run.promise, cancel: () => undefined };
        }}
        readCheckout={() => new Promise<CheckoutState>(() => undefined)}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("a")!);
    });
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("g")!);
    });
    await setup.flush();

    expect(startedPaths).toEqual([firstPath]);
    expect(setup.captureCharFrame()).toContain("batch 1/3");

    await React.act(async () => {
      runs[0]!.resolve("first result");
      await runs[0]!.promise;
      await Promise.resolve();
    });
    await setup.flush();

    expect(startedPaths).toEqual([firstPath, secondPath]);
    expect(startedPrompts.map((prompt) => prompt.split("\n")[0])).toEqual([
      "You are triaging maintenance work for octocat/first, checked out in the current directory.",
      "You are triaging maintenance work for octocat/second, checked out in the current directory.",
    ]);
    expect(setup.captureCharFrame()).toContain("batch 2/3");

    await React.act(async () => {
      runs[1]!.resolve("second result");
      await runs[1]!.promise;
      await Promise.resolve();
    });
    await setup.flush();

    const screen = setup.captureCharFrame();
    for (const text of [
      "octocat/first",
      "first result",
      "octocat/second",
      "second result",
      "octocat/missing",
      "skipped: not cloned",
    ]) {
      expect(screen).toContain(text);
    }
    expect(screen.indexOf("octocat/first")).toBeLessThan(screen.indexOf("first result"));
    expect(screen.indexOf("first result")).toBeLessThan(screen.indexOf("octocat/second"));
    expect(screen.indexOf("octocat/second")).toBeLessThan(screen.indexOf("second result"));
    expect(screen.indexOf("second result")).toBeLessThan(screen.indexOf("octocat/missing"));
    expect(screen.indexOf("octocat/missing")).toBeLessThan(screen.indexOf("skipped: not cloned"));
    expect(screen).toContain("batch 3/3");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("batch agent triage reports a failure and continues with the next repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-agent-batch-error-"));
  const firstPath = join(root, "first");
  const secondPath = join(root, "second");
  for (const [path, nameWithOwner] of [
    [firstPath, "octocat/first"],
    [secondPath, "octocat/second"],
  ] as const) {
    execFileSync("git", ["init", "-q", "-b", "main", path]);
    execFileSync("git", [
      "-C",
      path,
      "remote",
      "add",
      "origin",
      `https://github.com/${nameWithOwner}.git`,
    ]);
  }
  const runs = [deferred<string>(), deferred<string>()];
  let runIndex = 0;
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={{ ...config, roots: [root] }}
        initial={{
          ...snapshot,
          repos: [repo("octocat/first"), repo("octocat/second")],
        }}
        startAgent={() => {
          const run = runs[runIndex++]!;
          return { done: run.promise, cancel: () => undefined };
        }}
        readCheckout={() => new Promise<CheckoutState>(() => undefined)}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("a")!);
    });
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("g")!);
    });
    await setup.flush();

    await React.act(async () => {
      runs[0]!.reject(new Error("first failed"));
      await runs[0]!.promise.catch(() => undefined);
      await Promise.resolve();
    });
    await setup.flush();
    expect(runIndex).toBe(2);

    await React.act(async () => {
      runs[1]!.resolve("second result");
      await runs[1]!.promise;
      await Promise.resolve();
    });
    await setup.flush();

    const screen = setup.captureCharFrame();
    for (const text of [
      "octocat/first",
      "failed: first failed",
      "octocat/second",
      "second result",
    ]) {
      expect(screen).toContain(text);
    }
    expect(screen.indexOf("octocat/first")).toBeLessThan(screen.indexOf("failed: first failed"));
    expect(screen.indexOf("failed: first failed")).toBeLessThan(screen.indexOf("octocat/second"));
    expect(screen.indexOf("octocat/second")).toBeLessThan(screen.indexOf("second result"));
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("closing batch agent triage cancels the current run and stops the remaining queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-agent-batch-cancel-"));
  for (const name of ["first", "second"]) {
    const path = join(root, name);
    execFileSync("git", ["init", "-q", "-b", "main", path]);
    execFileSync("git", [
      "-C",
      path,
      "remote",
      "add",
      "origin",
      `https://github.com/octocat/${name}.git`,
    ]);
  }
  const firstRun = deferred<string>();
  let starts = 0;
  let cancelled = false;
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={{ ...config, roots: [root] }}
        initial={{
          ...snapshot,
          repos: [repo("octocat/first"), repo("octocat/second")],
        }}
        startAgent={() => {
          starts += 1;
          return {
            done: firstRun.promise,
            cancel: () => {
              cancelled = true;
            },
          };
        }}
        readCheckout={() => new Promise<CheckoutState>(() => undefined)}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("a")!);
    });
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("g")!);
    });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("batch 1/2");

    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("q")!);
    });
    expect(cancelled).toBe(true);

    await React.act(async () => {
      firstRun.reject(new Error("cancelled"));
      await firstRun.promise.catch(() => undefined);
      await Promise.resolve();
    });
    await setup.flush();

    expect(starts).toBe(1);
    expect(setup.captureCharFrame()).not.toContain("batch 2/2");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("triage uses the supplied agent boundary and renders its result", async () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-agent-boundary-"));
  const checkout = join(root, "triage");
  execFileSync("git", ["init", "-q", "-b", "main", checkout]);
  execFileSync("git", [
    "-C",
    checkout,
    "remote",
    "add",
    "origin",
    "https://github.com/octocat/triage.git",
  ]);
  const setup = await testRender(
    <ThemeProvider>
      <App
        config={{ ...config, roots: [root] }}
        initial={{ ...snapshot, repos: [repo("octocat/triage")] }}
        startAgent={() => ({
          done: Promise.resolve("controlled agent result"),
          cancel: () => undefined,
        })}
        readCheckout={() => new Promise<CheckoutState>(() => undefined)}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    await React.act(async () => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("g")!);
      await Promise.resolve();
    });
    await setup.flush();

    expect(setup.captureCharFrame()).toContain("controlled agent result");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

for (const staleOutcome of ["resolve", "reject"] as const) {
  test(`a cancelled triage ${staleOutcome} cannot replace or release its restarted run`, async () => {
    const root = mkdtempSync(join(tmpdir(), `maintainer-agent-stale-${staleOutcome}-`));
    const checkout = join(root, "triage");
    execFileSync("git", ["init", "-q", "-b", "main", checkout]);
    execFileSync("git", [
      "-C",
      checkout,
      "remote",
      "add",
      "origin",
      "https://github.com/octocat/triage.git",
    ]);
    const runs = [deferred<string>(), deferred<string>()];
    const cancelled = [false, false];
    let runIndex = 0;
    const setup = await testRender(
      <ThemeProvider>
        <App
          config={{ ...config, roots: [root] }}
          initial={{ ...snapshot, repos: [repo("octocat/triage")] }}
          startAgent={() => {
            const index = runIndex++;
            return {
              done: runs[index]!.promise,
              cancel: () => {
                cancelled[index] = true;
              },
            };
          }}
          readCheckout={() => new Promise<CheckoutState>(() => undefined)}
        />
      </ThemeProvider>,
      { width: 100, height: 40 },
    );

    try {
      await setup.flush();
      React.act(() => {
        setup.renderer.keyInput.processParsedKey(parseKeypress("g")!);
      });
      await setup.flush();
      React.act(() => {
        setup.renderer.keyInput.processParsedKey(parseKeypress("q")!);
      });
      expect(cancelled[0]).toBe(true);
      await setup.flush();
      React.act(() => {
        setup.renderer.keyInput.processParsedKey(parseKeypress("g")!);
      });
      await setup.flush();

      await React.act(async () => {
        if (staleOutcome === "resolve") {
          runs[0]!.resolve("stale agent output");
          await runs[0]!.promise;
        } else {
          runs[0]!.reject(new Error("stale agent failure"));
          await runs[0]!.promise.catch(() => undefined);
        }
      });
      await setup.flush();

      const screen = setup.captureCharFrame();
      expect(screen).toContain("thinking");
      // The modal covers the status label after its first character. The spinner and `c` prefix
      // still distinguish the current run's busy state from the idle footer underneath it.
      expect(screen).toMatch(/\n [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] c╰/);
      expect(screen).not.toContain("stale agent output");
      expect(screen).not.toContain("stale agent failure");

      React.act(() => {
        setup.renderer.keyInput.processParsedKey(parseKeypress("q")!);
      });
      expect(cancelled[1]).toBe(true);
    } finally {
      React.act(() => {
        setup.renderer.destroy();
      });
    }
  });
}

test("escape clears an applied search before it clears repository selection", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={snapshot} />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress(" ")!);
    });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("1 selected");

    for (const input of ["/", "l", "i", "v", "e", "\r"]) {
      React.act(() => {
        setup.renderer.keyInput.processParsedKey(parseKeypress(input)!);
      });
    }
    await setup.flush();
    expect(setup.captureCharFrame()).toContain(
      "1 selected · A clear · esc clear search · o open 0 · c clone 1",
    );

    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b")!);
    });
    await setup.flush();
    const afterSearchClear = setup.captureCharFrame();
    expect(afterSearchClear.split("\n").slice(0, 5).join("\n")).not.toContain("/live");
    expect(afterSearchClear).toContain("1 selected");

    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b")!);
    });
    await setup.flush();
    expect(setup.captureCharFrame()).not.toContain("selected");
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

test("the footer exposes hidden selections and actionable open and clone counts", async () => {
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={snapshot} />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  try {
    await setup.flush();
    React.act(() => {
      setup.renderer.keyInput.processParsedKey(parseKeypress(" ")!);
    });
    for (const input of ["/", "b", "o", "r", "r", "o", "w", "e", "d", "\r"]) {
      React.act(() => {
        setup.renderer.keyInput.processParsedKey(parseKeypress(input)!);
      });
    }
    await setup.flush();

    expect(setup.captureCharFrame()).toContain(
      "1 selected · 1 hidden · A clear · esc clear search · o open 0 · c clone 1",
    );
    expect(setup.captureCharFrame()).toMatch(/g\s+triage 1/);
  } finally {
    React.act(() => {
      setup.renderer.destroy();
    });
  }
});

// The row carries the short name and the detail pane carries the full one — the listing is where
// the owner is seventeen wasted cells, the detail pane is where the repo has to be unambiguous.
test("the owner is dropped from the row but kept in the detail pane", async () => {
  const screen = await frame();

  expect(rowFor(screen, "▸")).not.toContain("octocat/");
  expect(screen).toContain(": octocat/live");
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
// and archived repos are hidden until `x`, so this default-state frame never reaches the 28-cell
// case. It is covered for composition below and was measured by hand against a 100-column frame;
// a change to the column widths can still squeeze it without failing anything here.
test("a fork says so on its row, untruncated", async () => {
  const screen = await frame();
  const row = screen.split("\n").find((line) => line.includes("borrowed"));

  expect(row).toContain("fork · not cloned");
  expect(row).not.toContain("...");
});

// PR label formatting is covered here. The semantic binding test below drives `p` through the
// renderer; the populated and empty visual layouts were checked by hand against a 100-column frame.
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
  expect(prLabel(pr("octocat-labs/thing"), "octocat")).toBe("octocat-labs/thing#77");
});

test("the PR label is registered for semantic copy", async () => {
  const prSnapshot: Snapshot = {
    ...snapshot,
    attention: {
      reviewRequested: [],
      assigned: [],
      authored: [
        {
          repository: "octocat/live",
          number: 77,
          title: "Copy this PR",
          url: "",
          isDraft: false,
          updatedAt: "2026-08-01T00:00:00Z",
        },
      ],
    },
  };
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={prSnapshot} />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );
  await setup.flush();

  React.act(() => {
    setup.renderer.keyInput.processParsedKey(parseKeypress("p")!);
  });
  await setup.flush();

  const label = setup.renderer.root.findDescendantById("copy:pr:octocat/live#77");
  expect(label?.selectable).toBe(true);
});

test("the PR panel switches independent counted tabs and resets the row cursor", async () => {
  const overlap = attentionPr("octocat/overlap", 1, "Visible in both", "2026-07-01T00:00:00Z");
  const prSnapshot: Snapshot = {
    ...snapshot,
    attention: {
      authored: [
        attentionPr("octocat/authored", 2, "Authored only", "2026-08-01T00:00:00Z"),
        overlap,
      ],
      assigned: [
        attentionPr("octocat/assigned", 3, "Assigned only", "2026-08-10T00:00:00Z"),
        overlap,
      ],
      reviewRequested: [attentionPr("acme/review", 4, "Review only", "2026-06-01T00:00:00Z")],
    },
  };
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={prSnapshot} />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );
  await setup.flush();

  React.act(() => {
    setup.renderer.keyInput.processParsedKey(parseKeypress("p")!);
  });
  await setup.flush();
  const authored = setup.captureCharFrame();
  expect(authored).toContain("Authored (2)");
  expect(authored).toContain("Assigned (2)");
  expect(authored).toContain("Review requests (1)");
  expect(authored).toContain("Authored only");
  expect(authored).toContain("Visible in both");
  expect(authored).not.toContain("Assigned only");
  expect(authored).not.toContain("Review only");

  React.act(() => {
    setup.renderer.keyInput.processParsedKey(parseKeypress("j")!);
    setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[C")!);
  });
  await setup.flush();
  const assigned = setup.captureCharFrame();
  expect(assigned).toContain("Assigned only");
  expect(assigned).toContain("Visible in both");
  expect(assigned).not.toContain("Authored only");
  expect(rowFor(assigned, "Assigned only")).toContain("▸");

  React.act(() => {
    setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[C")!);
  });
  await setup.flush();
  const reviewRequested = setup.captureCharFrame();
  expect(reviewRequested).toContain("Review only");
  expect(reviewRequested).not.toContain("Visible in both");

  React.act(() => {
    setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[D")!);
  });
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("Assigned only");

  React.act(() => {
    setup.renderer.keyInput.processParsedKey(parseKeypress("[")!);
  });
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("Authored only");

  React.act(() => {
    setup.renderer.keyInput.processParsedKey(parseKeypress("]")!);
  });
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("Assigned only");
});

test("an empty PR tab keeps the tab strip visible", async () => {
  const prSnapshot: Snapshot = {
    ...snapshot,
    attention: {
      authored: [attentionPr("octocat/authored", 1, "Authored only", "2026-08-01T00:00:00Z")],
      assigned: [],
      reviewRequested: [],
    },
  };
  const setup = await testRender(
    <ThemeProvider>
      <App config={config} initial={prSnapshot} />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );
  await setup.flush();

  React.act(() => {
    setup.renderer.keyInput.processParsedKey(parseKeypress("p")!);
  });
  await setup.flush();
  React.act(() => {
    setup.renderer.keyInput.processParsedKey(parseKeypress("\u001b[C")!);
  });
  await setup.flush();
  const assigned = setup.captureCharFrame();

  expect(assigned).toContain("Authored (1)");
  expect(assigned).toContain("Assigned (0)");
  expect(assigned).toContain("Review requests (0)");
  expect(assigned).toContain("no pull requests in this tab");
});

test("the listing shortens the same names the PR panel does", () => {
  expect(withoutOwner("octocat/party-os", "octocat")).toBe("party-os");
  expect(withoutOwner("acme/shared-lib", "octocat")).toBe("acme/shared-lib");
  expect(withoutOwner("octocat-labs/thing", "octocat")).toBe("octocat-labs/thing");
});

// `/` is a mode, so its predicate is covered separately here. The mode itself was driven against a
// pty: typing `/catfood` as one chunk narrows 94 rows to 1, and the characters after the slash do
// not run as commands.
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
    staged: 0,
    modified: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    tracked: true,
  };

  expect(checkoutSummary(state)).toBe("main · clean");
  expect(checkoutSummary({ ...state, dirty: 1, staged: 1, modified: 1 })).toBe(
    "main · 1 staged · 1 modified",
  );
  expect(checkoutSummary({ ...state, dirty: 1, untracked: 1 })).toBe("main · 1 untracked");
  expect(checkoutSummary({ ...state, dirty: 3 })).toBe("main · 3 changed");
  expect(checkoutSummary({ ...state, ahead: 10 })).toBe("main · 10 unpushed · since last fetch");
  expect(checkoutSummary({ ...state, ahead: 1, behind: 2 })).toBe(
    "main · 1 unpushed · 2 behind · since last fetch",
  );
  // No upstream makes ahead/behind meaningless rather than zero, so they are not claimed.
  expect(checkoutSummary({ ...state, tracked: false })).toBe("main · no upstream");
  expect(checkoutSummary(null)).toBe("");
});

// A wide terminal was still truncating names against a column fixed at 30, with half the screen
// empty beside it.
test("the name column follows the terminal, up to the longest name present", () => {
  // Room to spare: the column stops at what the names need rather than filling.
  expect(nameColumnWidth(32, 215)).toBe(32);
  expect(nameColumnWidth(40, 215)).toBe(40);
  // Not enough room: it gives back what it must, leaving the tag column its 28.
  expect(nameColumnWidth(40, 100)).toBe(36);
  // Narrow enough that the tags have to give way instead.
  expect(nameColumnWidth(40, 70)).toBe(18);
});

// Same rule inside the PR panel, against a narrower budget: the modal is inset on both sides and
// the title has to keep enough room to still be a title.
test("the PR label column follows the terminal too", () => {
  expect(prLabelWidth(44, 215)).toBe(44);
  expect(prLabelWidth(44, 100)).toBe(39);
  expect(prLabelWidth(44, 60)).toBe(16);
});

test("tags compose in a fixed order", () => {
  const flagged = repo("octocat/flagged", { isFork: true, isArchived: true });

  expect(tags(flagged, undefined)).toBe("fork · archived · not cloned");
  expect(tags(repo("octocat/plain"), "/somewhere")).toBe("");
});

test("the watcher mark leaves its count readable", async () => {
  expect(await frame()).toContain("watchers 7");
});

test("an overlong name is truncated rather than wrapped onto the next row", async () => {
  const screen = await frame();

  expect(screen).not.toContain("a-deliberately-overlong-repository-name");
  expect(rowFor(screen, "a-deliberatel")).toMatch(/a-deliberatel.*\.\.\..*name/);
});

test("only registered semantic selections produce clipboard payloads", () => {
  const selection = (...ids: string[]) => ({
    selectedRenderables: ids.map((id, index) => ({
      id,
      x: index,
      y: 0,
      hasSelection: () => true,
    })),
  });

  const copyValues = new Map<string, string>([
    ["copy:repo", "octocat/live"],
    ["copy:branch", "feature/copy-on-select"],
  ]);

  expect(semanticSelectionPayload(selection("copy:repo"), copyValues)).toBe("octocat/live");

  expect(semanticSelectionPayload(selection("copy:repo", "copy:branch"), copyValues)).toBe(
    "octocat/live\nfeature/copy-on-select",
  );

  // 하나라도 허용되지 않은 UI 텍스트가 섞이면 복사하지 않습니다.
  expect(
    semanticSelectionPayload(selection("copy:repo", "decorative:stats"), copyValues),
  ).toBeNull();

  expect(semanticSelectionPayload(selection(), copyValues)).toBeNull();
});
