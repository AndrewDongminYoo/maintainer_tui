import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { runAgent } from "./agent.ts";
import type { Config } from "./config.ts";

const config: Config = {
  roots: [],
  cloneRoot: "/tmp",
  app: "Warp",
  mode: "tab",
  command: null,
  agent: "claude",
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(10);
  }
  return predicate();
};

test.serial("cancelling an agent run terminates its descendant process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maintainer-agent-process-group-"));
  const executable = join(directory, "claude");
  const pidFile = join(directory, "descendant.pid");
  writeFileSync(
    executable,
    '#!/bin/sh\nsleep 30 &\nprintf \'%s\\n\' "$!" > "$MAINTAINER_AGENT_PID_FILE"\nwait\n',
  );
  chmodSync(executable, 0o755);

  const previousPath = process.env.PATH;
  const previousPidFile = process.env.MAINTAINER_AGENT_PID_FILE;
  process.env.PATH = `${directory}:${previousPath ?? ""}`;
  process.env.MAINTAINER_AGENT_PID_FILE = pidFile;

  let descendantPid: number | undefined;
  const unrelated = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  unrelated.unref();
  const run = runAgent(config, directory, "test prompt");
  void run.done.catch(() => undefined);
  try {
    expect(await waitUntil(() => existsSync(pidFile), 1_000)).toBe(true);
    descendantPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    expect(isAlive(descendantPid)).toBe(true);

    run.cancel();

    expect(await waitUntil(() => !isAlive(descendantPid!), 1_000)).toBe(true);
    expect(isAlive(unrelated.pid!)).toBe(true);
    await expect(run.done).rejects.toThrow("cancelled");
    expect(() => run.cancel()).not.toThrow();
  } finally {
    run.cancel();
    if (descendantPid !== undefined && isAlive(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
    }
    try {
      process.kill(-unrelated.pid!, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await run.done.catch(() => undefined);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPidFile === undefined) delete process.env.MAINTAINER_AGENT_PID_FILE;
    else process.env.MAINTAINER_AGENT_PID_FILE = previousPidFile;
  }
});

test.serial(
  "cancelling an agent run force-kills a descendant that ignores SIGTERM",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "maintainer-agent-force-kill-"));
    const executable = join(directory, "claude");
    const pidFile = join(directory, "descendant.pid");
    writeFileSync(
      executable,
      '#!/bin/sh\n/bin/sh -c \'trap "" TERM; exec sleep 30\' </dev/null >/dev/null 2>&1 &\nprintf \'%s\\n\' "$!" > "$MAINTAINER_AGENT_PID_FILE"\nwait\n',
    );
    chmodSync(executable, 0o755);

    const previousPath = process.env.PATH;
    const previousPidFile = process.env.MAINTAINER_AGENT_PID_FILE;
    process.env.PATH = `${directory}:${previousPath ?? ""}`;
    process.env.MAINTAINER_AGENT_PID_FILE = pidFile;

    let descendantPid: number | undefined;
    const run = runAgent(config, directory, "test prompt", 5_000, 100);
    void run.done.catch(() => undefined);
    try {
      expect(await waitUntil(() => existsSync(pidFile), 1_000)).toBe(true);
      descendantPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      expect(isAlive(descendantPid)).toBe(true);

      run.cancel();

      expect(await waitUntil(() => !isAlive(descendantPid!), 1_000)).toBe(true);
      await expect(run.done).rejects.toThrow("cancelled");
    } finally {
      run.cancel();
      if (descendantPid !== undefined && isAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      await run.done.catch(() => undefined);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousPidFile === undefined) delete process.env.MAINTAINER_AGENT_PID_FILE;
      else process.env.MAINTAINER_AGENT_PID_FILE = previousPidFile;
    }
  },
  4_000,
);

test.serial(
  "an agent timeout terminates its descendant process",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "maintainer-agent-timeout-"));
    const executable = join(directory, "claude");
    const pidFile = join(directory, "descendant.pid");
    writeFileSync(
      executable,
      '#!/bin/sh\nsleep 30 &\nprintf \'%s\\n\' "$!" > "$MAINTAINER_AGENT_PID_FILE"\nwait\n',
    );
    chmodSync(executable, 0o755);

    const previousPath = process.env.PATH;
    const previousPidFile = process.env.MAINTAINER_AGENT_PID_FILE;
    process.env.PATH = `${directory}:${previousPath ?? ""}`;
    process.env.MAINTAINER_AGENT_PID_FILE = pidFile;

    let descendantPid: number | undefined;
    const run = runAgent(config, directory, "test prompt", 1_000);
    try {
      expect(await waitUntil(() => existsSync(pidFile), 800)).toBe(true);
      descendantPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      expect(isAlive(descendantPid)).toBe(true);

      await expect(run.done).rejects.toThrow("cancelled");
      expect(await waitUntil(() => !isAlive(descendantPid!), 1_000)).toBe(true);
    } finally {
      run.cancel();
      if (descendantPid !== undefined && isAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      await run.done.catch(() => undefined);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousPidFile === undefined) delete process.env.MAINTAINER_AGENT_PID_FILE;
      else process.env.MAINTAINER_AGENT_PID_FILE = previousPidFile;
    }
  },
  3_000,
);
