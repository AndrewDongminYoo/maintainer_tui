import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { version } from "../package.json";
import { SNAPSHOT_SCHEMA_VERSION, type Snapshot } from "./github.ts";

function runCli(
  args: string[],
  config: string | null = "{",
  cache: string | null = null,
  captureInitial = false,
) {
  const root = mkdtempSync(join(tmpdir(), "maintainer-cli-"));
  const configRoot = join(root, "config", "maintainer-tui");
  const configPath = join(configRoot, "config.json");
  const bin = join(root, "bin");
  const ghMarker = join(root, "gh-called");
  const rendererMarker = join(root, "renderer-called");
  const initialMarker = join(root, "initial-snapshot");
  const preload = join(root, "guard.ts");
  const corePath = Bun.resolveSync("@opentui/core", import.meta.dir);
  const reactPath = Bun.resolveSync("@opentui/react", import.meta.dir);

  try {
    mkdirSync(configRoot, { recursive: true });
    mkdirSync(bin);
    if (config !== null) writeFileSync(configPath, config);
    if (cache !== null) {
      const cacheRoot = join(root, "cache", "maintainer-tui");
      mkdirSync(cacheRoot, { recursive: true });
      writeFileSync(join(cacheRoot, "repos.json"), cache);
    }
    writeFileSync(
      join(bin, "gh"),
      '#!/bin/sh\nprintf called > "$TEST_GH_MARKER"\nprintf "fixture blocked GitHub\\n" >&2\nexit 81\n',
      { mode: 0o755 },
    );
    writeFileSync(
      preload,
      `import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
import * as core from ${JSON.stringify(corePath)};
import * as react from ${JSON.stringify(reactPath)};
const original = { ...core };
const originalReact = { ...react };
mock.module(${JSON.stringify(corePath)}, () => ({
  ...original,
  createCliRenderer() {
    writeFileSync(process.env.TEST_RENDERER_MARKER, "called");
    if (process.env.TEST_INITIAL_MARKER) return {};
    throw new Error("fixture blocked renderer");
  },
}));
if (process.env.TEST_INITIAL_MARKER) {
  mock.module(${JSON.stringify(reactPath)}, () => ({
    ...originalReact,
    createRoot() {
      return {
        render(element) {
          writeFileSync(process.env.TEST_INITIAL_MARKER, JSON.stringify(element.props.children.props.initial));
          process.exit(0);
        },
      };
    },
  }));
}
Object.defineProperty(process.stdin, "isTTY", { value: true });
`,
    );

    const result = spawnSync(
      process.execPath,
      ["--preload", preload, join(import.meta.dir, "cli.tsx"), ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: bin,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_CACHE_HOME: join(root, "cache"),
          TEST_GH_MARKER: ghMarker,
          TEST_RENDERER_MARKER: rendererMarker,
          TEST_INITIAL_MARKER: captureInitial ? initialMarker : "",
        },
      },
    );
    return {
      ...result,
      configPath,
      fixtureRoot: realpathSync(root),
      ghCalled: existsSync(ghMarker),
      rendererCalled: existsSync(rendererMarker),
      initialSnapshot: existsSync(initialMarker)
        ? JSON.parse(readFileSync(initialMarker, "utf8"))
        : undefined,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.each(["--help", "--h", "--version"])(
  "%s succeeds without configuration or startup side effects",
  (flag) => {
    const result = runCli([flag]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    if (flag === "--version") {
      expect(result.stdout).toBe(`maintainer ${version}\n`);
    } else {
      expect(result.stdout).toStartWith("maintainer — GitHub maintenance dashboard\n");
      expect(result.stdout).toContain("--sort=activity|popular");
    }
    expect(result.ghCalled).toBe(false);
    expect(result.rendererCalled).toBe(false);
  },
);

test("help still takes precedence over version with malformed configuration", () => {
  const result = runCli(["--version", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toStartWith("maintainer — GitHub maintenance dashboard\n");
  expect(result.stderr).toBe("");
  expect(result.ghCalled).toBe(false);
  expect(result.rendererCalled).toBe(false);
});

test.each(["--config", "--json", ""])(
  "configuration-dependent startup still rejects malformed JSON (%s)",
  (flag) => {
    const result = runCli(flag ? [flag] : []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${result.configPath} is not valid JSON`);
    expect(result.ghCalled).toBe(false);
    expect(result.rendererCalled).toBe(false);
  },
);

test("the subprocess guard detects a GitHub call from JSON startup", () => {
  const result = runCli(["--json", "--refresh"], "{}");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("fixture blocked GitHub");
  expect(result.ghCalled).toBe(true);
  expect(result.rendererCalled).toBe(false);
});

test("the subprocess guard detects renderer initialization from interactive startup", () => {
  const result = runCli([], "{}");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("fixture blocked renderer");
  expect(result.rendererCalled).toBe(true);
  expect(result.ghCalled).toBe(false);
});

test.each([
  ["configuration", null],
  ["configuration", []],
  ["configuration", "Warp"],
  ["configuration", 42],
  ["configuration", false],
  ["roots", { roots: "/projects" }],
  ["roots", { roots: null }],
  ["roots", { roots: ["/projects", 42] }],
  ["cloneRoot", { cloneRoot: 42 }],
  ["app", { app: null }],
  ["mode", { mode: "split" }],
  ["mode", { mode: false }],
  ["command", { command: [] }],
  ["agent", { agent: "unsupported" }],
  ["agent", { agent: null }],
] as const)("invalid configuration identifies its file and %s field", (field, config) => {
  const result = runCli(["--config"], JSON.stringify(config));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(result.configPath);
  expect(result.stderr).toContain(`invalid configuration field "${field}"`);
  expect(result.stderr).toContain("expected");
  expect(result.ghCalled).toBe(false);
  expect(result.rendererCalled).toBe(false);
});

test.each(["--json", ""])("invalid fields stop startup before side effects (%s)", (flag) => {
  const result = runCli(flag ? [flag] : [], '{"mode":"split"}');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${result.configPath}: invalid configuration field "mode"`);
  expect(result.stderr).toContain('expected "tab" or "window"');
  expect(result.stderr).not.toContain("is not valid JSON");
  expect(result.ghCalled).toBe(false);
  expect(result.rendererCalled).toBe(false);
});

test.each([null, "{}"])("absent or empty configuration preserves defaults (%s)", (config) => {
  const result = runCli(["--config"], config);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout.slice(result.stdout.indexOf("\n") + 1))).toEqual({
    roots: [result.fixtureRoot, join(homedir(), "Development")],
    cloneRoot: join(homedir(), "Development"),
    app: "Warp",
    mode: "tab",
    command: null,
    agent: "claude",
  });
});

test("valid partial configuration preserves defaults and custom application names", () => {
  const result = runCli(
    ["--config"],
    JSON.stringify({ roots: [], app: "Custom Editor", extension: "preserved" }),
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout.slice(result.stdout.indexOf("\n") + 1))).toEqual({
    roots: [result.fixtureRoot],
    cloneRoot: join(homedir(), "Development"),
    app: "Custom Editor",
    mode: "tab",
    command: null,
    agent: "claude",
    extension: "preserved",
  });
});

test("valid complete configuration preserves values and deduplicates roots", () => {
  const config = {
    roots: ["/projects", "/projects"],
    cloneRoot: "/clones",
    app: "Terminal",
    mode: "window",
    command: "echo ready",
    agent: "codex",
  };
  const result = runCli(["--config"], JSON.stringify(config));
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout.slice(result.stdout.indexOf("\n") + 1))).toEqual({
    ...config,
    roots: [result.fixtureRoot, "/projects"],
  });
});

function cachedSnapshot(): Snapshot {
  const pr = {
    repository: "octocat/example",
    number: 7,
    title: "Cached PR",
    url: "https://github.com/octocat/example/pull/7",
    isDraft: false,
    updatedAt: "2026-01-02T00:00:00Z",
  };
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    fetchedAt: Date.now() - 1_000,
    viewer: "octocat",
    repos: [
      {
        nameWithOwner: "octocat/example",
        url: "https://github.com/octocat/example",
        isPrivate: false,
        isArchived: false,
        isFork: false,
        pushedAt: "2026-01-01T00:00:00Z",
        stars: 1,
        forks: 2,
        watchers: 3,
        language: null,
        openIssues: 4,
        openPrs: 5,
        lastActivityAt: null,
        vulnCount: null,
        latestRelease: {
          tagName: "v1.0.0",
          createdAt: "2026-01-01T00:00:00Z",
          defaultBranchAheadBy: null,
        },
      },
    ],
    attention: { authored: [pr], assigned: [pr], reviewRequested: [pr] },
    attentionLimitReached: { authored: false, assigned: false, reviewRequested: false },
  };
}

test.each([false, true])(
  "fresh cache is preserved in JSON and initial TUI props (empty=%s)",
  (empty) => {
    const snapshot = cachedSnapshot();
    if (empty) {
      snapshot.repos = [];
      snapshot.attention = { authored: [], assigned: [], reviewRequested: [] };
    }
    const cache = JSON.stringify(snapshot);
    const json = runCli(["--json"], "{}", cache);
    expect(json.status).toBe(0);
    expect(json.stderr).toBe("");
    expect(json.ghCalled).toBe(false);
    const output = JSON.parse(json.stdout);
    expect(output.viewer).toBe(snapshot.viewer);
    expect(output.fetchedAt).toBe(new Date(snapshot.fetchedAt).toISOString());
    expect(output.repos).toHaveLength(snapshot.repos.length);
    expect(output.attention).toEqual(snapshot.attention);
    expect(output.attentionLimitReached).toEqual(snapshot.attentionLimitReached);
    const tui = runCli([], "{}", cache, true);
    expect(tui.status).toBe(0);
    expect(tui.stderr).toBe("");
    expect(tui.rendererCalled).toBe(true);
    expect(tui.ghCalled).toBe(false);
    expect(tui.initialSnapshot).toEqual(snapshot);
  },
);

test.each(["authored", "assigned", "reviewRequested"] as const)(
  "PR search limit metadata survives %s cache reuse and JSON output",
  (bucket) => {
    for (const [count, reached] of [
      [99, false],
      [100, true],
    ] as const) {
      const snapshot = cachedSnapshot();
      snapshot.attention[bucket] = Array.from({ length: count }, (_, index) => ({
        ...snapshot.attention[bucket][0]!,
        number: index + 1,
      }));
      snapshot.attentionLimitReached[bucket] = reached;
      const cache = JSON.stringify(snapshot);
      const json = runCli(["--json"], "{}", cache);
      expect(json.status).toBe(0);
      expect(json.ghCalled).toBe(false);
      const output = JSON.parse(json.stdout);
      expect(output.attention[bucket]).toHaveLength(count);
      expect(output.attentionLimitReached).toEqual({
        authored: false,
        assigned: false,
        reviewRequested: false,
        [bucket]: reached,
      });
      const tui = runCli([], "{}", cache, true);
      expect(tui.status).toBe(0);
      expect(tui.ghCalled).toBe(false);
      expect(tui.initialSnapshot).toEqual(snapshot);
    }
  },
);

test("valid optional repository metadata and extra cache fields are preserved", () => {
  const snapshot = cachedSnapshot();
  const first = snapshot.repos[0]!;
  snapshot.repos = [
    {
      ...first,
      language: "TypeScript",
      lastActivityAt: "2026-01-02T00:00:00Z",
      vulnCount: 2,
      latestRelease: null,
    },
    {
      ...first,
      latestRelease: { tagName: "v1", createdAt: "2026-01-01T00:00:00Z", defaultBranchAheadBy: 3 },
    },
  ];
  const cache = { ...snapshot, extension: "preserved" };
  const result = runCli([], "{}", JSON.stringify(cache), true);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.ghCalled).toBe(false);
  expect(result.initialSnapshot).toEqual(cache);
});

test.each([
  ["missing timestamp", { fetchedAt: undefined }],
  ["string timestamp", { fetchedAt: "2026-01-01" }],
  ["numeric string timestamp", { fetchedAt: String(Date.now()) }],
  ["null timestamp", { fetchedAt: null }],
  ["negative timestamp", { fetchedAt: -1 }],
  ["future timestamp", { fetchedAt: Date.now() + 60 * 60 * 1_000 }],
  ["expired timestamp", { fetchedAt: Date.now() - 11 * 60 * 1_000 }],
  ["wrong schema", { schemaVersion: SNAPSHOT_SCHEMA_VERSION - 1 }],
  ["missing schema", { schemaVersion: undefined }],
  ["missing repositories", { repos: undefined }],
  ["missing attention", { attention: undefined }],
  ["missing limit metadata", { attentionLimitReached: undefined }],
  ["null limit metadata", { attentionLimitReached: null }],
  ["empty limit metadata", { attentionLimitReached: {} }],
  [
    "non-boolean limit metadata",
    { attentionLimitReached: { authored: "false", assigned: false, reviewRequested: false } },
  ],
] as const)("%s is a cache miss in JSON and TUI startup", (_label, changes) => {
  const cache = JSON.stringify({ ...cachedSnapshot(), ...changes });
  const json = runCli(["--json"], "{}", cache);
  expect(json.status).toBe(1);
  expect(json.stderr).toContain("fixture blocked GitHub");
  expect(json.ghCalled).toBe(true);
  expect(json.rendererCalled).toBe(false);
  const tui = runCli([], "{}", cache, true);
  expect(tui.status).toBe(0);
  expect(tui.stderr).toBe("");
  expect(tui.initialSnapshot).toBeNull();
});

test.each(["authored", "assigned", "reviewRequested"] as const)(
  "inconsistent PR search limit metadata for %s is a cache miss",
  (bucket) => {
    for (const [count, reached] of [
      [1, true],
      [100, false],
      [101, true],
    ] as const) {
      const snapshot = cachedSnapshot();
      snapshot.attention[bucket] = Array.from({ length: count }, (_, index) => ({
        ...snapshot.attention[bucket][0]!,
        number: index + 1,
      }));
      snapshot.attentionLimitReached[bucket] = reached;
      const result = runCli([], "{}", JSON.stringify(snapshot), true);
      expect(result.status).toBe(0);
      expect(result.initialSnapshot).toBeNull();
    }
  },
);

test.each(["{", "null", "[]", '{"fetchedAt":1e999,"schemaVersion":4}'])(
  "unreadable cache data is discarded before TUI initialization (%s)",
  (cache) => {
    const result = runCli([], "{}", cache, true);
    expect(result.status).toBe(0);
    expect(result.initialSnapshot).toBeNull();
  },
);

test.each([
  ["viewer", 42],
  ["repos", null],
  ["repos", [null]],
  ["attention", null],
  ["attention", {}],
  ["attention", { authored: [], assigned: [] }],
] as const)("malformed snapshot %s is not passed to the TUI", (field, value) => {
  const result = runCli([], "{}", JSON.stringify({ ...cachedSnapshot(), [field]: value }), true);
  expect(result.status).toBe(0);
  expect(result.initialSnapshot).toBeNull();
});

test.each([
  ["nameWithOwner", null],
  ["url", 42],
  ["isPrivate", "false"],
  ["isArchived", null],
  ["isFork", 0],
  ["pushedAt", "invalid"],
  ["stars", -1],
  ["forks", 0.5],
  ["watchers", null],
  ["language", 42],
  ["openIssues", "1"],
  ["openPrs", undefined],
  ["lastActivityAt", "invalid"],
  ["vulnCount", false],
  ["latestRelease", {}],
  ["latestRelease", { tagName: "v1", createdAt: "invalid", defaultBranchAheadBy: 0 }],
  ["latestRelease", { tagName: 42, createdAt: "2026-01-01", defaultBranchAheadBy: 0 }],
  ["latestRelease", { tagName: "v1", createdAt: "2026-01-01", defaultBranchAheadBy: "1" }],
] as const)("malformed repository %s is not passed to the TUI", (field, value) => {
  const snapshot = cachedSnapshot();
  const cache = JSON.stringify({ ...snapshot, repos: [{ ...snapshot.repos[0], [field]: value }] });
  const result = runCli([], "{}", cache, true);
  expect(result.status).toBe(0);
  expect(result.initialSnapshot).toBeNull();
});

test.each(["authored", "assigned", "reviewRequested"] as const)(
  "malformed %s bucket is rejected",
  (bucket) => {
    const snapshot = cachedSnapshot();
    for (const value of [null, {}, [null], [{ ...snapshot.attention[bucket][0], number: 0 }]]) {
      const cache = JSON.stringify({
        ...snapshot,
        attention: { ...snapshot.attention, [bucket]: value },
      });
      const result = runCli([], "{}", cache, true);
      expect(result.status).toBe(0);
      expect(result.initialSnapshot).toBeNull();
    }
  },
);

test.each([
  ["repository", null],
  ["number", 1.5],
  ["title", 42],
  ["url", null],
  ["isDraft", "false"],
  ["updatedAt", "invalid"],
] as const)("malformed PR %s is rejected", (field, value) => {
  const snapshot = cachedSnapshot();
  const cache = JSON.stringify({
    ...snapshot,
    attention: {
      ...snapshot.attention,
      authored: [{ ...snapshot.attention.authored[0], [field]: value }],
    },
  });
  const result = runCli([], "{}", cache, true);
  expect(result.status).toBe(0);
  expect(result.initialSnapshot).toBeNull();
});

test("refresh bypasses a valid cache", () => {
  const result = runCli(["--json", "--refresh"], "{}", JSON.stringify(cachedSnapshot()));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("fixture blocked GitHub");
  expect(result.ghCalled).toBe(true);
});
