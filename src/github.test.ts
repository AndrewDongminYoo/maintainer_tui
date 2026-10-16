import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { triagePrompt } from "./agent.ts";
import { filterRepos, type PrBucket, type Repo, type Snapshot } from "./github.ts";

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

interface Response {
  stdout?: unknown;
  stderr?: string;
  code?: number;
}

interface Scenario {
  graphql: { cursor: string | null; response: Response }[];
  searches?: Partial<Record<PrBucket, Response>>;
}

function page(repos: Repo[], cursor: string | null = null) {
  return {
    data: {
      viewer: {
        login: "octocat",
        repositories: {
          pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
          nodes: repos.map((item) => ({
            ...item,
            stargazerCount: item.stars,
            forkCount: item.forks,
            watchers: { totalCount: item.watchers },
            primaryLanguage: item.language === null ? null : { name: item.language },
            issues: { totalCount: item.openIssues, nodes: [] },
            pullRequests: { totalCount: item.openPrs, nodes: [] },
            vulnerabilityAlerts: item.vulnCount === null ? null : { totalCount: item.vulnCount },
          })),
        },
      },
    },
  };
}

function runFetch(scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), "maintainer-fetch-"));
  const bin = join(root, "bin");
  const callsPath = join(root, "calls.jsonl");
  try {
    mkdirSync(bin);
    writeFileSync(join(root, "scenario.json"), JSON.stringify(scenario));
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = ${JSON.stringify(root)};
const scenario = JSON.parse(readFileSync(join(root, "scenario.json"), "utf8"));
const args = process.argv.slice(2);
appendFileSync(join(root, "calls.jsonl"), JSON.stringify(args) + "\\n");
function fail(message) { console.error("fixture: " + message); process.exit(81); }
let response;
if (args[0] === "api" && args[1] === "graphql") {
  const counter = join(root, "graphql-count");
  const index = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  const step = scenario.graphql[index];
  if (!step) fail("unexpected GraphQL request");
  const cursorArgs = step.cursor === null ? [] : ["-F", "cursor=" + step.cursor];
  if (args[2] !== "-f" || !args[3]?.startsWith("query=\\nquery($cursor: String)")) fail("invalid GraphQL arguments");
  if (JSON.stringify(args.slice(4)) !== JSON.stringify(cursorArgs)) fail("unexpected cursor arguments");
  writeFileSync(counter, String(index + 1));
  response = step.response;
} else {
  const filters = { authored: "--author=@me", assigned: "--assignee=@me", reviewRequested: "--review-requested=@me" };
  const bucket = Object.keys(filters).find((key) => args[2] === filters[key]);
  if (!bucket) fail("unknown PR bucket");
  const expected = ["search", "prs", filters[bucket], "--state=open", "--archived=false", "--sort=updated", "--order=desc", "--limit=100", "--json", "repository,number,title,url,isDraft,updatedAt"];
  if (JSON.stringify(args) !== JSON.stringify(expected)) fail("unexpected search arguments");
  try { writeFileSync(join(root, bucket), "called", { flag: "wx" }); }
  catch { fail("duplicate PR bucket"); }
  response = scenario.searches?.[bucket] ?? { stdout: [] };
}
if (response.stdout !== undefined) console.log(JSON.stringify(response.stdout));
if (response.stderr) console.error(response.stderr);
process.exitCode = response.code ?? 0;
`,
      { mode: 0o755 },
    );
    const modulePath = join(import.meta.dir, "github.ts");
    const result = spawnSync(
      process.execPath,
      [
        "--eval",
        `
import { fetchSnapshot } from ${JSON.stringify(modulePath)};
try { console.log(JSON.stringify({ snapshot: await fetchSnapshot() })); }
catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; }
`,
      ],
      { cwd: root, encoding: "utf8", timeout: 10_000, env: { PATH: bin } },
    );
    if (result.error) throw result.error;
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as { snapshot?: Snapshot; error?: string };
    const calls: string[][] = existsSync(callsPath)
      ? readFileSync(callsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    return { ...payload, status: result.status, calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const graphqlCalls = (calls: string[][]) => calls.filter((args) => args[0] === "api");
const searchCalls = (calls: string[][]) => calls.filter((args) => args[0] === "search");

test("a partial GitHub response preserves unavailable vulnerability data", () => {
  const unavailable = repo({ nameWithOwner: "octocat/unavailable", vulnCount: null });
  const result = runFetch({
    graphql: [
      {
        cursor: null,
        response: {
          stdout: { ...page([unavailable]), errors: [{ message: "Resource not accessible" }] },
          code: 1,
        },
      },
    ],
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.snapshot?.repos).toEqual([unavailable]);
  expect(graphqlCalls(result.calls)).toHaveLength(1);
  expect(searchCalls(result.calls)).toHaveLength(3);
});

test("pagination forwards every cursor and accumulates repository pages", () => {
  const repos = [
    repo({ nameWithOwner: "octocat/first" }),
    repo({ nameWithOwner: "octocat/second" }),
    repo({ nameWithOwner: "octocat/third" }),
  ];
  const result = runFetch({
    graphql: [
      { cursor: null, response: { stdout: page([repos[0]!], "cursor-one") } },
      { cursor: "cursor-one", response: { stdout: page([repos[1]!], "cursor-two") } },
      { cursor: "cursor-two", response: { stdout: page([repos[2]!]) } },
    ],
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.snapshot?.viewer).toBe("octocat");
  expect(result.snapshot?.repos).toEqual(repos);
  expect(graphqlCalls(result.calls).map((args) => args.slice(4))).toEqual([
    [],
    ["-F", "cursor=cursor-one"],
    ["-F", "cursor=cursor-two"],
  ]);
  expect(searchCalls(result.calls)).toHaveLength(3);
});

test("a transient failure retries the same later-page cursor", () => {
  const first = repo({ nameWithOwner: "octocat/first" });
  const second = repo({ nameWithOwner: "octocat/second" });
  const result = runFetch({
    graphql: [
      { cursor: null, response: { stdout: page([first], "next-page") } },
      { cursor: "next-page", response: { stderr: "temporary upstream failure", code: 1 } },
      { cursor: "next-page", response: { stdout: page([second]) } },
    ],
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.snapshot?.repos).toEqual([first, second]);
  expect(graphqlCalls(result.calls).map((args) => args.slice(4))).toEqual([
    [],
    ["-F", "cursor=next-page"],
    ["-F", "cursor=next-page"],
  ]);
});

test("exhausted retries reject with the last diagnostic before PR searches", () => {
  const result = runFetch({
    graphql: [
      { cursor: null, response: { stderr: "first failure", code: 1 } },
      {
        cursor: null,
        response: { stdout: { errors: [{ message: "final GraphQL failure" }] }, code: 1 },
      },
    ],
  });
  expect(result.status).toBe(1);
  expect(result.snapshot).toBeUndefined();
  expect(result.error).toBe("final GraphQL failure");
  expect(graphqlCalls(result.calls)).toHaveLength(2);
  expect(searchCalls(result.calls)).toHaveLength(0);
});

test("populated PR buckets retain their independent filters and results", () => {
  const row = (number: number) => ({
    repository: { nameWithOwner: "octocat/example" },
    number,
    title: `PR ${number}`,
    url: `https://github.com/octocat/example/pull/${number}`,
    isDraft: number === 2,
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const result = runFetch({
    graphql: [{ cursor: null, response: { stdout: page([]) } }],
    searches: {
      authored: { stdout: [row(1)] },
      assigned: { stdout: [row(2)] },
      reviewRequested: { stdout: [row(3)] },
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.snapshot?.attention).toEqual({
    authored: [{ ...row(1), repository: "octocat/example" }],
    assigned: [{ ...row(2), repository: "octocat/example" }],
    reviewRequested: [{ ...row(3), repository: "octocat/example" }],
  });
  expect(
    searchCalls(result.calls)
      .map((args) => args[2])
      .sort(),
  ).toEqual(["--assignee=@me", "--author=@me", "--review-requested=@me"]);
});

test("a failed PR search rejects the entire snapshot", () => {
  const result = runFetch({
    graphql: [{ cursor: null, response: { stdout: page([repo()]) } }],
    searches: {
      assigned: { stderr: "assigned search unavailable", code: 1 },
    },
  });
  expect(result.status).toBe(1);
  expect(result.snapshot).toBeUndefined();
  expect(result.error).toContain("assigned search unavailable");
  expect(searchCalls(result.calls)).toHaveLength(3);
});

test("vulnerability filters keep repositories with unavailable alert data actionable", () => {
  const unavailable = repo({ vulnCount: null });

  expect(filterRepos([unavailable], "vuln")).toEqual([unavailable]);
  expect(filterRepos([unavailable], "attention")).toEqual([unavailable]);
});

test("the triage prompt names unavailable vulnerability data", () => {
  expect(triagePrompt(repo({ vulnCount: null }))).toContain("open Dependabot alerts: unavailable");
});
