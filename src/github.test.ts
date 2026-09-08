import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { triagePrompt } from "./agent.ts";
import { fetchSnapshot, filterRepos, type Repo } from "./github.ts";

const repo = (over: Partial<Repo> = {}): Repo => ({
  nameWithOwner: "octocat/example",
  url: "https://github.com/octocat/example",
  isPrivate: false,
  isArchived: false,
  isFork: false,
  pushedAt: "2026-01-01T00:00:00Z",
  stars: 0,
  forks: 0,
  watchers: 0,
  language: null,
  openIssues: 0,
  openPrs: 0,
  lastActivityAt: null,
  vulnCount: 0,
  latestRelease: null,
  ...over,
});

test.serial("a partial GitHub response preserves unavailable vulnerability data", async () => {
  const root = mkdtempSync(join(tmpdir(), "maintainer-gh-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  const payload = JSON.stringify({
    data: {
      viewer: {
        login: "octocat",
        repositories: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              nameWithOwner: "octocat/unavailable",
              url: "https://github.com/octocat/unavailable",
              isPrivate: false,
              isArchived: false,
              isFork: false,
              pushedAt: "2026-01-01T00:00:00Z",
              latestRelease: null,
              stargazerCount: 0,
              forkCount: 0,
              watchers: { totalCount: 0 },
              primaryLanguage: null,
              issues: { totalCount: 0, nodes: [] },
              pullRequests: { totalCount: 0, nodes: [] },
              vulnerabilityAlerts: null,
            },
          ],
        },
      },
    },
    errors: [{ message: "Resource not accessible" }],
  });
  writeFileSync(
    gh,
    `#!/bin/sh\nif [ "$1" = "api" ]; then\n  printf '%s\\n' '${payload}'\n  exit 1\nfi\nprintf '%s\\n' '[]'\n`,
  );
  chmodSync(gh, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ""}`;

  try {
    const snapshot = await fetchSnapshot();
    expect(snapshot.repos[0]?.vulnCount).toBeNull();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("vulnerability filters keep repositories with unavailable alert data actionable", () => {
  const unavailable = repo({ vulnCount: null });

  expect(filterRepos([unavailable], "vuln")).toEqual([unavailable]);
  expect(filterRepos([unavailable], "attention")).toEqual([unavailable]);
});

test("the triage prompt names unavailable vulnerability data", () => {
  expect(triagePrompt(repo({ vulnCount: null }))).toContain("open Dependabot alerts: unavailable");
});
