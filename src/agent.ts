import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AgentName, Config } from "./config.ts";
import { needsRelease, type Repo } from "./github.ts";

const run = promisify(execFile);

const TIMEOUT_MS = 5 * 60 * 1000;

const ARGV: Record<AgentName, (prompt: string) => string[]> = {
  claude: (prompt) => ["-p", prompt],
  codex: (prompt) => ["exec", prompt],
};

/** The deterministic findings this session already has, handed to the agent as context. */
export function triagePrompt(repo: Repo): string {
  const facts = [
    `open PRs: ${repo.openPrs}`,
    `open issues: ${repo.openIssues}`,
    `open Dependabot alerts: ${repo.vulnCount}`,
    repo.latestRelease
      ? `latest release: ${repo.latestRelease.tagName} (${repo.latestRelease.createdAt})${
          needsRelease(repo)
            ? ", with unreleased commits on the default branch"
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

export async function runAgent(
  config: Config,
  cwd: string,
  prompt: string,
): Promise<string> {
  const { stdout } = await run(config.agent, ARGV[config.agent](prompt), {
    cwd,
    timeout: TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}
