import { spawn } from "node:child_process";

import type { AgentName, Config } from "./config.ts";
import { releaseStatus, type Repo } from "./github.ts";

const TIMEOUT_MS = 5 * 60 * 1000;

const ARGV: Record<AgentName, (prompt: string) => string[]> = {
  claude: (prompt) => ["-p", prompt],
  codex: (prompt) => ["exec", prompt],
};

/** The deterministic findings this session already has, handed to the agent as context. */
export function triagePrompt(repo: Repo): string {
  const repoReleaseStatus = releaseStatus(repo);
  const facts = [
    `open PRs: ${repo.openPrs}`,
    `open issues: ${repo.openIssues}`,
    `open Dependabot alerts: ${repo.vulnCount}`,
    repo.latestRelease
      ? `latest release: ${repo.latestRelease.tagName} (${repo.latestRelease.createdAt})${
          repoReleaseStatus === "unreleased"
            ? ", with unreleased commits on the default branch"
            : repoReleaseStatus === "unknown"
              ? ", default-branch comparison unavailable"
              : ""
        }`
      : "no releases yet",
  ].join("\n- ");

  return [
    `You are triaging maintenance work for ${repo.nameWithOwner}, checked out in the current directory.`,
    "",
    "Known from the GitHub API:",
    `- ${facts}`,
    "",
    "Inspect the working tree and report, in at most 15 lines:",
    "1. Which open PRs are safe to merge and which need a human decision.",
    "2. Whether the dependency advisories are reachable in this codebase.",
    "3. Whether a version bump is warranted, and what semver level.",
    "",
    "Be concrete and cite files. Do not modify anything.",
  ].join("\n");
}

export interface AgentRun {
  /** The agent's stdout, or a rejection if it failed, timed out, or was cancelled. */
  done: Promise<string>;
  cancel: () => void;
}

/**
 * A triage turn runs for minutes, so the child is spawned rather than awaited: closing the
 * overlay has to actually stop it. Awaiting `execFile` left the agent running to its timeout
 * with nothing holding the handle, so browsing a few repos accumulated orphans.
 */
export function runAgent(config: Config, cwd: string, prompt: string): AgentRun {
  const child = spawn(config.agent, ARGV[config.agent](prompt), {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let cancelled = false;
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const timer = setTimeout(() => {
    cancelled = true;
    child.kill("SIGKILL");
  }, TIMEOUT_MS);

  const done = new Promise<string>((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        (error as { code?: string }).code === "ENOENT"
          ? new Error(`${config.agent} is not installed`)
          : error,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (cancelled) return reject(new Error("cancelled"));
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(stderr.trim().split("\n").at(-1) || `${config.agent} exited ${code}`));
    });
  });

  return {
    done,
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
    },
  };
}
