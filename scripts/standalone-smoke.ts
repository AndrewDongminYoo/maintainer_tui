import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SNAPSHOT_SCHEMA_VERSION, type Snapshot } from "../src/github.ts";

const TIMEOUT_MS = 10_000;
const projectRoot = join(import.meta.dir, "..");
const sourceBinary = join(projectRoot, "dist", "maintainer");

if (!existsSync(sourceBinary)) {
  throw new Error(`standalone binary is missing: ${sourceBinary}`);
}

const sandboxRoot = mkdtempSync(join(tmpdir(), "maintainer-standalone-"));
const runRoot = join(sandboxRoot, "run");
const cacheRoot = join(sandboxRoot, "cache");
const configRoot = join(sandboxRoot, "config", "maintainer-tui");
const binary = join(runRoot, "maintainer");
const snapshot: Snapshot = {
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  fetchedAt: Date.now(),
  viewer: "standalone-smoke",
  repos: [],
  attention: { reviewRequested: [], authored: [], assigned: [] },
};

try {
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(join(cacheRoot, "maintainer-tui"), { recursive: true });
  mkdirSync(configRoot, { recursive: true });
  copyFileSync(sourceBinary, binary);
  writeFileSync(join(cacheRoot, "maintainer-tui", "repos.json"), JSON.stringify(snapshot));
  writeFileSync(
    join(configRoot, "config.json"),
    JSON.stringify({
      roots: [],
      cloneRoot: sandboxRoot,
      app: "Warp",
      mode: "tab",
      command: null,
      agent: "claude",
    }),
  );

  const output: string[] = [];
  const terminal = new Bun.Terminal({
    cols: 100,
    rows: 40,
    data(_terminal, data) {
      output.push(new TextDecoder().decode(data));
    },
  });
  const child = Bun.spawn([binary], {
    cwd: runRoot,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TERM: "xterm-256color",
      XDG_CACHE_HOME: cacheRoot,
      XDG_CONFIG_HOME: join(sandboxRoot, "config"),
    },
    terminal,
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, TIMEOUT_MS);

  try {
    const renderDeadline = Date.now() + TIMEOUT_MS / 2;
    while (!output.join("").includes("maintainer")) {
      if (child.exitCode !== null) {
        throw new Error(`standalone binary exited before rendering: ${child.exitCode}`);
      }
      if (Date.now() >= renderDeadline) {
        throw new Error("standalone binary did not reach the renderer");
      }
      await Bun.sleep(25);
    }

    terminal.write("q");
    const exitCode = await child.exited;
    if (timedOut) throw new Error(`standalone binary timed out after ${TIMEOUT_MS}ms`);
    if (exitCode !== 0) throw new Error(`standalone binary exited with ${exitCode}`);
    console.log("standalone smoke passed");
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    terminal.close();
  }
} finally {
  rmSync(sandboxRoot, { recursive: true, force: true });
}
