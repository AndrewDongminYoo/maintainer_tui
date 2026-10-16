import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { version } from "../package.json";

function runCli(args: string[], config: string | null = "{") {
  const root = mkdtempSync(join(tmpdir(), "maintainer-cli-"));
  const configRoot = join(root, "config", "maintainer-tui");
  const configPath = join(configRoot, "config.json");
  const bin = join(root, "bin");
  const ghMarker = join(root, "gh-called");
  const rendererMarker = join(root, "renderer-called");
  const preload = join(root, "guard.ts");
  const corePath = Bun.resolveSync("@opentui/core", import.meta.dir);

  try {
    mkdirSync(configRoot, { recursive: true });
    mkdirSync(bin);
    if (config !== null) writeFileSync(configPath, config);
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
const original = { ...core };
mock.module(${JSON.stringify(corePath)}, () => ({
  ...original,
  createCliRenderer() {
    writeFileSync(process.env.TEST_RENDERER_MARKER, "called");
    throw new Error("fixture blocked renderer");
  },
}));
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
        },
      },
    );
    return {
      ...result,
      configPath,
      fixtureRoot: realpathSync(root),
      ghCalled: existsSync(ghMarker),
      rendererCalled: existsSync(rendererMarker),
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
