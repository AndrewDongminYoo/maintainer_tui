import { Box, Text, useApp, useInput, useStdout } from "ink";
import * as React from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Divider } from "@/components/ui/divider";
import { KeyValue } from "@/components/ui/key-value";
import { KeyboardShortcuts } from "@/components/ui/keyboard-shortcuts";
import { Spinner } from "@/components/ui/spinner";
import { useTheme } from "@/hooks/use-theme";

import { runAgent, triagePrompt, type AgentRun } from "./agent.ts";
import type { Config } from "./config.ts";
import { writeCache } from "./config.ts";
import {
  fetchSnapshot,
  filterRepos,
  needsRelease,
  sortRepos,
  type FilterMode,
  type Repo,
  type Snapshot,
  type SortMode,
} from "./github.ts";
import {
  cloneRepo,
  launchAll,
  resolveLocal,
  scanRoots,
  supportsCommand,
} from "./local.ts";

const SORTS: SortMode[] = ["activity", "popular"];
const FILTERS: FilterMode[] = ["all", "attention", "vuln", "release"];

const SHORTCUTS = [
  { key: "↑/↓ j/k", description: "move" },
  { key: "space", description: "select" },
  { key: "a / A", description: "all / none" },
  { key: "s", description: "sort" },
  { key: "f", description: "filter" },
  { key: "x", description: "show archived" },
  { key: "o", description: "open selected" },
  { key: "c", description: "clone missing" },
  { key: "g", description: "agent triage" },
  { key: "r", description: "refresh" },
  { key: "?", description: "help" },
  { key: "q", description: "quit" },
];

function cycle<T>(values: readonly T[], current: T): T {
  return values[(values.indexOf(current) + 1) % values.length] ?? current;
}

/** Fetch age, which is minutes-scale and needs finer buckets than `relative`. */
function since(epochMs: number): string {
  const minutes = Math.floor((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function relative(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

type Status =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "error"; message: string };

export interface AppProps {
  config: Config;
  initial: Snapshot | null;
}

export function App({ config, initial }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const theme = useTheme();

  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(initial);
  const [status, setStatus] = React.useState<Status>(
    initial ? { kind: "idle" } : { kind: "busy", label: "querying GitHub" },
  );
  const [locals, setLocals] = React.useState<Map<string, string>>(() =>
    scanRoots(config.roots),
  );
  const [sort, setSort] = React.useState<SortMode>("activity");
  const [filter, setFilter] = React.useState<FilterMode>("all");
  const [showArchived, setShowArchived] = React.useState(false);
  const [cursor, setCursor] = React.useState(0);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [overlay, setOverlay] = React.useState<"none" | "help" | "agent">(
    "none",
  );
  const [agentOutput, setAgentOutput] = React.useState("");
  const agentRun = React.useRef<AgentRun | null>(null);

  // Archived repos are read-only history that never needs maintaining, so they are out of the
  // pool before any filter runs rather than being one more filter mode.
  const visible = React.useMemo(
    () =>
      sortRepos(
        filterRepos(
          (snapshot?.repos ?? []).filter((r) => showArchived || !r.isArchived),
          filter,
        ),
        sort,
      ),
    [snapshot, filter, sort, showArchived],
  );

  // Keep the cursor inside the list when a filter shrinks it.
  const index = Math.min(cursor, Math.max(visible.length - 1, 0));
  const focused: Repo | undefined = visible[index];
  const rows = Math.max(6, (stdout?.rows ?? 30) - 16);
  const start = Math.max(
    0,
    Math.min(index - Math.floor(rows / 2), visible.length - rows),
  );
  const localPath = (repo: Repo): string | undefined =>
    resolveLocal(locals, repo.nameWithOwner);

  const refresh = React.useCallback(async () => {
    setStatus({ kind: "busy", label: "querying GitHub" });
    try {
      const next = await fetchSnapshot();
      writeCache(next);
      setSnapshot(next);
      setLocals(scanRoots(config.roots));
      setStatus({ kind: "idle" });
    } catch (error) {
      setStatus({ kind: "error", message: (error as Error).message });
    }
  }, [config.roots]);

  React.useEffect(() => {
    if (!initial) void refresh();
  }, [initial, refresh]);

  const selectedRepos = React.useMemo(
    () => (snapshot?.repos ?? []).filter((r) => selected.has(r.nameWithOwner)),
    [snapshot, selected],
  );

  const open = React.useCallback(async () => {
    const targets =
      selectedRepos.length > 0 ? selectedRepos : focused ? [focused] : [];
    const paths = targets.map(localPath).filter((p): p is string => Boolean(p));
    const missing = targets.length - paths.length;
    if (paths.length === 0) {
      setStatus({
        kind: "error",
        message: "nothing cloned locally — press c to clone first",
      });
      return;
    }
    setStatus({
      kind: "busy",
      label: `opening ${paths.length} in ${config.app}`,
    });
    const results = await launchAll(paths, config);
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      setStatus({
        kind: "error",
        message: `${failed.length} failed: ${failed[0]?.error}`,
      });
    } else if (missing > 0) {
      setStatus({
        kind: "error",
        message: `opened ${paths.length}, skipped ${missing} not cloned`,
      });
    } else {
      setStatus({ kind: "idle" });
    }
  }, [selectedRepos, focused, config, locals]);

  const clone = React.useCallback(async () => {
    const targets = (
      selectedRepos.length > 0 ? selectedRepos : focused ? [focused] : []
    ).filter((r) => !localPath(r));
    if (targets.length === 0) {
      setStatus({
        kind: "error",
        message: "all selected repos are already cloned",
      });
      return;
    }
    for (const [done, repo] of targets.entries()) {
      setStatus({
        kind: "busy",
        label: `cloning ${repo.nameWithOwner} (${done + 1}/${targets.length})`,
      });
      try {
        const path = await cloneRepo(repo.nameWithOwner, config.cloneRoot);
        setLocals((prev) =>
          new Map(prev).set(repo.nameWithOwner.toLowerCase(), path),
        );
      } catch (error) {
        setStatus({
          kind: "error",
          message: `${repo.nameWithOwner}: ${(error as Error).message}`,
        });
        return;
      }
    }
    setStatus({ kind: "idle" });
  }, [selectedRepos, focused, config.cloneRoot, locals]);

  const triage = React.useCallback(async () => {
    if (!focused) return;
    const path = localPath(focused);
    if (!path) {
      setStatus({
        kind: "error",
        message: "clone the repo before running the agent",
      });
      return;
    }
    setOverlay("agent");
    setAgentOutput("");
    setStatus({
      kind: "busy",
      label: `${config.agent} triaging ${focused.nameWithOwner}`,
    });
    const current = runAgent(config, path, triagePrompt(focused));
    agentRun.current = current;
    try {
      setAgentOutput(await current.done);
    } catch (error) {
      const message = (error as Error).message;
      setAgentOutput(message === "cancelled" ? "" : `failed: ${message}`);
    } finally {
      agentRun.current = null;
      setStatus({ kind: "idle" });
    }
  }, [focused, config, locals]);

  useInput((input, key) => {
    if (overlay !== "none") {
      if (input === "q" || key.escape || input === "?") {
        // Closing the overlay has to stop the turn too, or it runs on to its timeout unwatched.
        agentRun.current?.cancel();
        agentRun.current = null;
        setOverlay("none");
        setStatus({ kind: "idle" });
      }
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    if (key.downArrow || input === "j")
      setCursor(Math.min(index + 1, visible.length - 1));
    if (key.upArrow || input === "k") setCursor(Math.max(index - 1, 0));
    if (input === " " && focused) {
      const name = focused.nameWithOwner;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
    }
    if (input === "a")
      setSelected(new Set(visible.map((r) => r.nameWithOwner)));
    if (input === "A") setSelected(new Set());
    if (input === "s") setSort(cycle(SORTS, sort));
    if (input === "f") {
      setFilter(cycle(FILTERS, filter));
      setCursor(0);
    }
    if (input === "x") {
      setShowArchived(!showArchived);
      setCursor(0);
    }
    if (input === "o") void open();
    if (input === "c") void clone();
    if (input === "g") void triage();
    if (input === "r") void refresh();
    if (input === "?") setOverlay("help");
  });

  if (overlay === "help") {
    return (
      <Box flexDirection="column" padding={1}>
        <KeyboardShortcuts
          shortcuts={SHORTCUTS}
          columns={2}
          title="maintainer"
        />
        <Box marginTop={1}>
          <Text color={theme.colors.mutedForeground}>
            open target: {config.app} · {config.mode}
            {config.command ? ` · runs ${config.command}` : ""}
            {config.command && !supportsCommand(config)
              ? " (ignored — app cannot run commands)"
              : ""}
          </Text>
        </Box>
        <Text color={theme.colors.mutedForeground}>any key to close</Text>
      </Box>
    );
  }

  if (overlay === "agent") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={theme.colors.accent}>
          {config.agent} · {focused?.nameWithOwner}
        </Text>
        <Divider />
        {agentOutput ? (
          <Text>{agentOutput}</Text>
        ) : (
          <Spinner label="thinking" />
        )}
        <Box marginTop={1}>
          <Text color={theme.colors.mutedForeground}>q to close</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box gap={1}>
        <Text bold color={theme.colors.accent}>
          maintainer
        </Text>
        <Text color={theme.colors.mutedForeground}>
          {snapshot
            ? `${visible.length}/${snapshot.repos.length} repos · ${snapshot.viewer}`
            : ""}
        </Text>
        <Text color={theme.colors.secondaryForeground}>sort:{sort}</Text>
        <Text color={theme.colors.secondaryForeground}>filter:{filter}</Text>
        {showArchived ? (
          <Text color={theme.colors.secondaryForeground}>+archived</Text>
        ) : null}
        {selected.size > 0 ? (
          <Badge variant="info">{`${selected.size} selected`}</Badge>
        ) : null}
      </Box>

      {snapshot ? (
        <Box gap={1}>
          <Text color={theme.colors.mutedForeground}>
            review requested: {snapshot.attention.reviewRequested.length} ·
            yours open: {snapshot.attention.authored.length} · fetched{" "}
            {since(snapshot.fetchedAt)}
          </Text>
        </Box>
      ) : null}

      <Divider />

      <Box flexDirection="column">
        {visible.slice(start, start + rows).map((repo, offset) => {
          const position = start + offset;
          const isFocused = position === index;
          const mark = selected.has(repo.nameWithOwner) ? "[x]" : "[ ]";
          const cloned = localPath(repo);
          return (
            <Box key={repo.nameWithOwner} gap={1}>
              <Text
                color={
                  isFocused ? theme.colors.accent : theme.colors.mutedForeground
                }
              >
                {isFocused ? "▸" : " "}
                {mark}
              </Text>
              <Box width={40}>
                <Text
                  bold={isFocused}
                  color={
                    cloned
                      ? theme.colors.foreground
                      : theme.colors.mutedForeground
                  }
                  wrap="truncate"
                >
                  {repo.nameWithOwner}
                </Text>
              </Box>
              <Box width={9}>
                <Text color={theme.colors.error}>
                  {repo.vulnCount > 0 ? `⚠ ${repo.vulnCount}` : ""}
                </Text>
              </Box>
              <Box width={7}>
                <Text color={theme.colors.info}>
                  {repo.openPrs > 0 ? `${repo.openPrs} PR` : ""}
                </Text>
              </Box>
              <Box width={9}>
                <Text color={theme.colors.warning}>
                  {needsRelease(repo) ? "bump" : ""}
                </Text>
              </Box>
              <Box width={6}>
                <Text color={theme.colors.mutedForeground}>
                  {relative(repo.lastActivityAt ?? repo.pushedAt)}
                </Text>
              </Box>
              <Text color={theme.colors.mutedForeground}>
                {cloned ? "" : "· remote only"}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Divider />

      {focused ? (
        <KeyValue
          keyWidth={9}
          items={[
            {
              key: "repo",
              value: `${focused.nameWithOwner}${focused.isArchived ? " (archived)" : ""}`,
            },
            {
              key: "stats",
              // ◉ rather than 👁: the bare eye codepoint measures 1 cell but renders as a
              // two-cell emoji in Warp, so it ate the watcher count and flickered on every
              // re-render. The other two marks are BMP symbols and measure what they draw.
              value: `★${focused.stars} ⑂${focused.forks} ◉${focused.watchers} · ${focused.language ?? "—"}`,
            },
            {
              key: "release",
              value: focused.latestRelease
                ? `${focused.latestRelease.tagName}${needsRelease(focused) ? " · unreleased commits on default branch" : " · up to date"}`
                : "none published",
            },
            { key: "local", value: localPath(focused) ?? "not cloned" },
          ]}
        />
      ) : (
        <Text color={theme.colors.mutedForeground}>
          no repos match this filter
        </Text>
      )}

      <Box marginTop={1}>
        {status.kind === "busy" ? <Spinner label={status.label} /> : null}
        {status.kind === "error" ? (
          <Alert variant="error">{status.message}</Alert>
        ) : null}
        {status.kind === "idle" ? (
          <Text color={theme.colors.mutedForeground}>
            space select · o open · c clone · g agent · s sort · f filter · x
            archived · ? help · q quit
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
