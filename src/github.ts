import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** GitHub caps GraphQL connections at 100 nodes per page. */
const PAGE_SIZE = 100;
const MAX_BUFFER = 32 * 1024 * 1024;

export interface Repo {
  nameWithOwner: string;
  url: string;
  isPrivate: boolean;
  isArchived: boolean;
  isFork: boolean;
  pushedAt: string;
  stars: number;
  forks: number;
  watchers: number;
  language: string | null;
  openIssues: number;
  openPrs: number;
  /** Newest updatedAt across open issues and PRs; null when nothing is open. */
  lastActivityAt: string | null;
  vulnCount: number;
  latestRelease: { tagName: string; createdAt: string } | null;
}

export interface Attention {
  reviewRequested: PrRef[];
  authored: PrRef[];
}

export interface PrRef {
  repository: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
}

export interface Snapshot {
  fetchedAt: number;
  viewer: string;
  repos: Repo[];
  attention: Attention;
}

const LIST_QUERY = `
query($cursor: String) {
  viewer {
    login
    repositories(
      first: ${PAGE_SIZE}
      after: $cursor
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner
        url
        isPrivate
        isArchived
        isFork
        pushedAt
        stargazerCount
        forkCount
        watchers { totalCount }
        primaryLanguage { name }
        issues(states: OPEN, first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) {
          totalCount
          nodes { updatedAt }
        }
        pullRequests(states: OPEN, first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) {
          totalCount
          nodes { updatedAt }
        }
        vulnerabilityAlerts(states: OPEN) { totalCount }
        latestRelease { tagName createdAt }
      }
    }
  }
}`;

interface GqlNode {
  nameWithOwner: string;
  url: string;
  isPrivate: boolean;
  isArchived: boolean;
  isFork: boolean;
  pushedAt: string;
  stargazerCount: number;
  forkCount: number;
  watchers: { totalCount: number };
  primaryLanguage: { name: string } | null;
  issues: { totalCount: number; nodes: { updatedAt: string }[] };
  pullRequests: { totalCount: number; nodes: { updatedAt: string }[] };
  vulnerabilityAlerts: { totalCount: number } | null;
  latestRelease: { tagName: string; createdAt: string } | null;
}

/**
 * `gh api graphql` exits non-zero when GitHub returns a partial result with a top-level
 * `errors` array — which happens for any repo where the token lacks admin (and therefore
 * cannot read `vulnerabilityAlerts`). Parse stdout regardless of exit status and only throw
 * when there is no usable `data` payload.
 */
async function gql<T>(
  query: string,
  variables: Record<string, string> = {},
): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables))
    args.push("-F", `${key}=${value}`);

  let stdout: string;
  try {
    ({ stdout } = await run("gh", args, { maxBuffer: MAX_BUFFER }));
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? "";
    if (!stdout.trim()) throw error;
  }

  const parsed = JSON.parse(stdout) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (!parsed.data)
    throw new Error(
      parsed.errors?.map((e) => e.message).join("; ") ?? "empty response",
    );
  return parsed.data;
}

function toRepo(node: GqlNode): Repo {
  const stamps = [
    node.issues.nodes[0]?.updatedAt,
    node.pullRequests.nodes[0]?.updatedAt,
  ].filter((value): value is string => Boolean(value));
  return {
    nameWithOwner: node.nameWithOwner,
    url: node.url,
    isPrivate: node.isPrivate,
    isArchived: node.isArchived,
    isFork: node.isFork,
    pushedAt: node.pushedAt,
    stars: node.stargazerCount,
    forks: node.forkCount,
    watchers: node.watchers.totalCount,
    language: node.primaryLanguage?.name ?? null,
    openIssues: node.issues.totalCount,
    openPrs: node.pullRequests.totalCount,
    lastActivityAt: stamps.sort().at(-1) ?? null,
    // Null means "not readable with this token", which is not the same as zero — but for a
    // dashboard both mean "nothing actionable shown", so collapse to 0 rather than guess.
    vulnCount: node.vulnerabilityAlerts?.totalCount ?? 0,
    latestRelease: node.latestRelease,
  };
}

async function searchPrs(filter: string): Promise<PrRef[]> {
  const { stdout } = await run(
    "gh",
    [
      "search",
      "prs",
      "--state=open",
      filter,
      "--limit=100",
      "--json",
      "repository,number,title,url,isDraft,updatedAt",
    ],
    { maxBuffer: MAX_BUFFER },
  );
  const rows = JSON.parse(stdout) as ({
    repository: { nameWithOwner: string };
  } & Omit<PrRef, "repository">)[];
  return rows.map(({ repository, ...rest }) => ({
    ...rest,
    repository: repository.nameWithOwner,
  }));
}

export async function fetchSnapshot(): Promise<Snapshot> {
  const repos: Repo[] = [];
  let viewer = "";
  let cursor: string | undefined;

  do {
    const data = await gql<{
      viewer: {
        login: string;
        repositories: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          nodes: GqlNode[];
        };
      };
    }>(LIST_QUERY, cursor ? { cursor } : {});

    viewer = data.viewer.login;
    repos.push(...data.viewer.repositories.nodes.map(toRepo));
    const { hasNextPage, endCursor } = data.viewer.repositories.pageInfo;
    cursor = hasNextPage ? endCursor : undefined;
  } while (cursor);

  const [reviewRequested, authored] = await Promise.all([
    searchPrs("--review-requested=@me"),
    searchPrs("--author=@me"),
  ]);

  return {
    fetchedAt: Date.now(),
    viewer,
    repos,
    attention: { reviewRequested, authored },
  };
}

export type SortMode = "activity" | "popular";

/** True when the default branch moved after the most recent release. */
export function needsRelease(repo: Repo): boolean {
  if (!repo.latestRelease) return false;
  return Date.parse(repo.pushedAt) > Date.parse(repo.latestRelease.createdAt);
}

/**
 * Default sort is two-tier: repos with an open issue or PR come first, ordered by that
 * conversation's recency; everything else follows, ordered by last push.
 */
export function sortRepos(repos: Repo[], mode: SortMode): Repo[] {
  const copy = [...repos];
  if (mode === "popular") {
    return copy.sort(
      (a, b) =>
        b.stars - a.stars || b.forks - a.forks || b.watchers - a.watchers,
    );
  }
  return copy.sort((a, b) => {
    const aOpen = a.lastActivityAt !== null;
    const bOpen = b.lastActivityAt !== null;
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    const aAt = Date.parse(a.lastActivityAt ?? a.pushedAt);
    const bAt = Date.parse(b.lastActivityAt ?? b.pushedAt);
    return bAt - aAt;
  });
}

export type FilterMode = "all" | "attention" | "vuln" | "release";

export function filterRepos(repos: Repo[], mode: FilterMode): Repo[] {
  switch (mode) {
    case "attention":
      return repos.filter(
        (r) => r.openPrs > 0 || r.vulnCount > 0 || needsRelease(r),
      );
    case "vuln":
      return repos.filter((r) => r.vulnCount > 0);
    case "release":
      return repos.filter(needsRelease);
    default:
      return repos;
  }
}
