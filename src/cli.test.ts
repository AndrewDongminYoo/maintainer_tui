import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { version } from "../package.json";

function runCli(args: string[], config = "{") {
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
    writeFileSync(configPath, config);
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
