import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** GitHub caps GraphQL connections at 100 nodes per page; use 50 to leave response headroom for per-repository comparisons. */
const PAGE_SIZE = 50;
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
  latestRelease: {
    tagName: string;
    createdAt: string;
    defaultBranchAheadBy: number | null;
  } | null;
}

export interface Attention {
  reviewRequested: PrRef[];
  authored: PrRef[];
  assigned: PrRef[];
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
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  fetchedAt: number;
  viewer: string;
  repos: Repo[];
  attention: Attention;
}

export const SNAPSHOT_SCHEMA_VERSION = 3;

export type PrBucket = "authored" | "assigned" | "reviewRequested";

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
        latestRelease {
          tagName
          createdAt
          tag {
            compare(headRef: "HEAD") { aheadBy }
          }
        }
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
  latestRelease: {
    tagName: string;
    createdAt: string;
    tag: { compare: { aheadBy: number } | null } | null;
  } | null;
}

/**
 * `gh api graphql` exits non-zero when GitHub returns a partial result with a top-level
 * `errors` array — which happens for any repo where the token lacks admin (and therefore
 * cannot read `vulnerabilityAlerts`). Parse stdout regardless of exit status and only throw
 * when there is no usable `data` payload.
 */
async function gql<T>(query: string, variables: Record<string, string> = {}): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) args.push("-F", `${key}=${value}`);

  // One retry, because a single flaky call would otherwise take the whole listing down
  // mid-pagination — observed once against a healthy rate limit.
  let last: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
    try {
      return await once<T>(args);
    } catch (error) {
      last = error as Error;
    }
  }
  throw last ?? new Error("gh api graphql failed");
}

async function once<T>(args: string[]): Promise<T> {
  let stdout: string;
  try {
    ({ stdout } = await run("gh", args, { maxBuffer: MAX_BUFFER }));
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: string;
    };
    if (failure.code === "ENOENT") {
      throw new Error("gh is not installed — see https://cli.github.com");
    }
    stdout = failure.stdout ?? "";
    // execFile's own message is the entire command, which for this query is hundreds of lines
    // of GraphQL. What is worth reading is whatever gh said.
    if (!stdout.trim()) throw new Error(failure.stderr?.trim() || "gh api graphql failed");
  }

  const parsed = JSON.parse(stdout) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (!parsed.data)
    throw new Error(parsed.errors?.map((e) => e.message).join("; ") ?? "empty response");
  return parsed.data;
}

function toRepo(node: GqlNode): Repo {
  const stamps = [node.issues.nodes[0]?.updatedAt, node.pullRequests.nodes[0]?.updatedAt].filter(
    (value): value is string => Boolean(value),
  );
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
    latestRelease: node.latestRelease
      ? {
          tagName: node.latestRelease.tagName,
          createdAt: node.latestRelease.createdAt,
          defaultBranchAheadBy: node.latestRelease.tag?.compare?.aheadBy ?? null,
        }
      : null,
  };
}

export function prSearchArgs(bucket: PrBucket): string[] {
  const filter: Record<PrBucket, string> = {
    authored: "--author=@me",
    assigned: "--assignee=@me",
    reviewRequested: "--review-requested=@me",
  };

  return [
    "search",
    "prs",
    filter[bucket],
    "--state=open",
    "--archived=false",
    "--sort=updated",
    "--order=desc",
    "--limit=100",
    "--json",
    "repository,number,title,url,isDraft,updatedAt",
  ];
}

async function searchPrs(bucket: PrBucket): Promise<PrRef[]> {
  const { stdout } = await run("gh", prSearchArgs(bucket), { maxBuffer: MAX_BUFFER });
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

  const [authored, assigned, reviewRequested] = await Promise.all([
    searchPrs("authored"),
    searchPrs("assigned"),
    searchPrs("reviewRequested"),
  ]);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    fetchedAt: Date.now(),
    viewer,
    repos,
    attention: { reviewRequested, authored, assigned },
  };
}

export type SortMode = "activity" | "popular";
export type ReleaseStatus = "none" | "current" | "unreleased" | "unknown";

export function releaseStatus(repo: Repo): ReleaseStatus {
  if (!repo.latestRelease) return "none";
  if (repo.latestRelease.defaultBranchAheadBy === null) return "unknown";
  return repo.latestRelease.defaultBranchAheadBy > 0 ? "unreleased" : "current";
}

/** True when the default branch contains commits absent from the most recent release tag. */
export function needsRelease(repo: Repo): boolean {
  return releaseStatus(repo) === "unreleased";
}

/**
 * Default sort is two-tier: repos with an open issue or PR come first, ordered by that
 * conversation's recency; everything else follows, ordered by last push.
 */
export function sortRepos(repos: Repo[], mode: SortMode): Repo[] {
  const copy = [...repos];
  if (mode === "popular") {
    return copy.sort((a, b) => b.stars - a.stars || b.forks - a.forks || b.watchers - a.watchers);
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

export interface QueuedPr extends PrRef {
  /** True when someone else is blocked on this one, rather than the viewer being blocked on it. */
  waitingOnReview: boolean;
}

/** Returns one independently searchable PR tab, or the legacy combined queue when no tab is supplied. */
export function prQueue(attention: Attention, bucket?: PrBucket): QueuedPr[] {
  const byRecency = (a: PrRef, b: PrRef): number =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  const tag = (prs: PrRef[], waitingOnReview: boolean): QueuedPr[] =>
    [...prs].sort(byRecency).map((pr) => ({ ...pr, waitingOnReview }));

  if (bucket) return tag(attention[bucket], bucket === "reviewRequested");

  return [...tag(attention.reviewRequested, true), ...tag(attention.authored, false)];
}

export type FilterMode = "all" | "attention" | "vuln" | "release";

export function filterRepos(repos: Repo[], mode: FilterMode): Repo[] {
  const releaseNeedsAttention = (repo: Repo): boolean => {
    const status = releaseStatus(repo);
    return status === "unreleased" || status === "unknown";
  };

  switch (mode) {
    case "attention":
      return repos.filter((r) => r.openPrs > 0 || r.vulnCount > 0 || releaseNeedsAttention(r));
    case "vuln":
      return repos.filter((r) => r.vulnCount > 0);
    case "release":
      return repos.filter(releaseNeedsAttention);
    default:
      return repos;
  }
}
