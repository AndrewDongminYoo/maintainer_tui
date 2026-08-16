import { createTextAttributes } from "@opentui/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
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
  prQueue,
  sortRepos,
  type FilterMode,
  type Repo,
  type QueuedPr,
  type Snapshot,
  type SortMode,
} from "./github.ts";
import {
  cloneRepo,
  launchAll,
  openUrl,
  resolveLocal,
  scanRoots,
  supportsCommand,
} from "./local.ts";

const SORTS: SortMode[] = ["activity", "popular"];
const FILTERS: FilterMode[] = ["all", "attention", "vuln", "release"];

const BOLD = createTextAttributes({ bold: true });

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
  { key: "p", description: "pull requests" },
  { key: "r", description: "refresh" },
  { key: "?", description: "help" },
  { key: "q", description: "quit" },
];

function cycle<T>(values: readonly T[], current: T): T {
  return values[(values.indexOf(current) + 1) % values.length] ?? current;
}

/**
 * Builds a clamped cursor mover that goes through the functional updater.
 *
 * A held key repeats faster than React re-renders, so several presses land in one tick; anything
 * derived from a captured index resolves them all to the same value and keeps only the last —
 * five presses moved the list cursor two rows before this existed. Shared so a second cursor
 * cannot quietly reintroduce it. Re-clamped inside, because a cursor is free to sit past the end
 * of a list that a filter has since shortened.
 */
function stepper(
  setCursor: React.Dispatch<React.SetStateAction<number>>,
  length: number,
): (delta: number) => void {
  return (delta) =>
    setCursor((previous) => {
      const last = Math.max(length - 1, 0);
      return Math.max(0, Math.min(Math.min(previous, last) + delta, last));
    });
}

/** Fetch age, which is minutes-scale and needs finer buckets than `relative`. */
function since(epochMs: number): string {
  const minutes = Math.floor((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

/**
 * The trailing note on a row: what the repo is, rather than what it needs.
 *
 * `fork` earns its place beyond bookkeeping — a fork inherits upstream's Dependabot alerts, so
 * the ⚠ column on one can read 1056 without a single one of them being the viewer's to fix.
 *
 * `not cloned` says whose fact it is. The other two describe the repository on GitHub, and a
 * word like "remote" reads as one more of those rather than a statement about this machine —
 * which is also how the detail pane already words it.
 */
export function tags(repo: Repo, clonedPath: string | undefined): string {
  return [
    repo.isFork ? "fork" : null,
    repo.isArchived ? "archived" : null,
    clonedPath ? null : "not cloned",
  ]
    .filter((note): note is string => note !== null)
    .join(" · ");
}

/**
 * Drops the owner from `owner/name` when the owner is the viewer.
 *
 * Almost everything either panel lists belongs to the viewer — 123 of 126 repositories here — so
 * the owner is the same seventeen cells on every row, spent to say nothing, while the part that
 * identifies the repo is what gets truncated for it. The rows that belong to someone else keep
 * their owner, which is exactly where it carries information.
 */
export function withoutOwner(nameWithOwner: string, viewer: string): string {
  const own = `${viewer}/`;
  return nameWithOwner.startsWith(own)
    ? nameWithOwner.slice(own.length)
    : nameWithOwner;
}

export function prLabel(pr: QueuedPr, viewer: string): string {
  return `${withoutOwner(pr.repository, viewer)}#${pr.number}`;
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

export function App({ config, initial }: AppProps): React.ReactNode {
  const renderer = useRenderer();
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
  const [overlay, setOverlay] = React.useState<
    "none" | "help" | "agent" | "prs"
  >("none");
  const [prCursor, setPrCursor] = React.useState(0);
  const [agentOutput, setAgentOutput] = React.useState("");
  const agentRun = React.useRef<AgentRun | null>(null);
  const listRef = React.useRef<ScrollBoxRenderable>(null);
  const modalRef = React.useRef<ScrollBoxRenderable>(null);

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

  const queue = React.useMemo(
    () => (snapshot ? prQueue(snapshot.attention) : []),
    [snapshot],
  );
  const prIndex = Math.min(prCursor, Math.max(queue.length - 1, 0));

  // Keep the cursor inside the list when a filter shrinks it.
  const index = Math.min(cursor, Math.max(visible.length - 1, 0));
  const focused: Repo | undefined = visible[index];
  const localPath = (repo: Repo): string | undefined =>
    resolveLocal(locals, repo.nameWithOwner);

  const move = stepper(setCursor, visible.length);
  const movePr = stepper(setPrCursor, queue.length);

  // The scrollbox scrolls itself for the wheel but knows nothing about the cursor, and a filter
  // that shortens the list can leave it parked past the end.
  React.useEffect(() => {
    const box = listRef.current;
    const viewport = box?.viewport.height ?? 0;
    if (!box || viewport <= 0) return;
    box.scrollTop = Math.min(
      box.scrollTop,
      Math.max(0, visible.length - viewport),
    );
    if (index < box.scrollTop) box.scrollTop = index;
    else if (index >= box.scrollTop + viewport)
      box.scrollTop = index - viewport + 1;
  }, [index, visible.length]);

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

  useKeyboard((key) => {
    // `name` collapses shifted letters onto the unshifted key, so the literal character has to
    // come from `sequence` — `a` and `A` are different commands here.
    const input = key.sequence.length === 1 ? key.sequence : "";

    if (overlay !== "none") {
      if (input === "q" || key.name === "escape" || input === "?") {
        // Closing the overlay has to stop the turn too, or it runs on to its timeout unwatched.
        agentRun.current?.cancel();
        agentRun.current = null;
        setOverlay("none");
        setStatus({ kind: "idle" });
        return;
      }
      // The PR panel has a cursor, so j/k move it and the viewport follows. The agent reply has
      // none — nothing in it is selectable — so there j/k scroll the body directly.
      if (overlay === "prs") {
        if (key.name === "down" || input === "j") movePr(1);
        if (key.name === "up" || input === "k") movePr(-1);
        if (input === "o" || key.name === "return") {
          const pr = queue[prIndex];
          if (pr) void openUrl(pr.url);
        }
        return;
      }
      const body = modalRef.current;
      if (body) {
        if (key.name === "down" || input === "j") body.scrollBy(1);
        if (key.name === "up" || input === "k") body.scrollBy(-1);
      }
      return;
    }
    if (input === "q" || (key.ctrl && key.name === "c")) {
      renderer.destroy();
      process.exit(0);
    }
    if (key.name === "down" || input === "j") move(1);
    if (key.name === "up" || input === "k") move(-1);
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
    if (input === "p") {
      setPrCursor(0);
      setOverlay("prs");
    }
  });

  // One scrollbox serves every overlay, so its offset survives a close. Without this, scrolling a
  // triage reply and then opening the PR panel drops the viewer into the middle of the queue.
  React.useEffect(() => {
    if (modalRef.current) modalRef.current.scrollTop = 0;
  }, [overlay]);

  // The panel's viewport follows its cursor, the same way the listing's does.
  React.useEffect(() => {
    const box = modalRef.current;
    const viewport = box?.viewport.height ?? 0;
    if (!box || viewport <= 0 || overlay !== "prs") return;
    if (prIndex < box.scrollTop) box.scrollTop = prIndex;
    else if (prIndex >= box.scrollTop + viewport)
      box.scrollTop = prIndex - viewport + 1;
  }, [prIndex, overlay]);

  /**
   * Overlays float over the listing rather than replacing it.
   *
   * `backgroundColor` is what makes that safe: an absolutely positioned box paints only the cells
   * it draws into, so without a fill the rows underneath show through the gaps in the content.
   *
   * `bottom` is what makes it survive: the box needs a definite height, or a long body runs off
   * the screen painting over the status bar — a 40-line triage reply did exactly that. With the
   * height pinned, the inner scrollbox clips and scrolls instead. The close hint lives in the
   * border so it cannot scroll out of view.
   */
  const modal = (
    title: string,
    footer: string,
    children: React.ReactNode,
  ): React.ReactNode => (
    <box
      position="absolute"
      top={3}
      left={4}
      right={4}
      bottom={2}
      zIndex={10}
      flexDirection="column"
      padding={1}
      border
      borderStyle="rounded"
      borderColor={theme.colors.accent}
      backgroundColor={theme.colors.background}
      title={` ${title} `}
      titleAlignment="center"
      bottomTitle={` ${footer} `}
      bottomTitleAlignment="center"
    >
      <scrollbox
        ref={modalRef}
        flexGrow={1}
        scrollX={false}
        contentOptions={{ flexDirection: "column" }}
      >
        {children}
      </scrollbox>
    </box>
  );

  // Only the list flexes. Every other band is flexShrink={0}: OpenTUI does not clip a child that
  // no longer fits, it draws it over its neighbour, so one row of overrun corrupts the whole
  // bottom of the screen rather than merely truncating it.
  return (
    <box flexDirection="column" padding={1} flexGrow={1}>
      <box flexDirection="column" flexShrink={0}>
        <box flexDirection="row" gap={1}>
          <text attributes={BOLD} fg={theme.colors.accent}>
            maintainer
          </text>
          <text fg={theme.colors.mutedForeground}>
            {snapshot
              ? `${visible.length}/${snapshot.repos.length} repos · ${snapshot.viewer}`
              : ""}
          </text>
          <text fg={theme.colors.secondaryForeground}>{`sort:${sort}`}</text>
          <text
            fg={theme.colors.secondaryForeground}
          >{`filter:${filter}`}</text>
          {showArchived ? (
            <text fg={theme.colors.secondaryForeground}>+archived</text>
          ) : null}
          {selected.size > 0 ? (
            <Badge variant="info">{`${selected.size} selected`}</Badge>
          ) : null}
        </box>

        {snapshot ? (
          <box flexDirection="row" gap={1}>
            <text fg={theme.colors.mutedForeground}>
              {`review requested: ${snapshot.attention.reviewRequested.length} · yours open: ${snapshot.attention.authored.length} · fetched ${since(snapshot.fetchedAt)}`}
            </text>
          </box>
        ) : null}

        <Divider />
      </box>

      <scrollbox
        ref={listRef}
        flexGrow={1}
        flexShrink={1}
        scrollX={false}
        contentOptions={{ flexDirection: "column" }}
      >
        {visible.map((repo, position) => {
          const isFocused = position === index;
          const mark = selected.has(repo.nameWithOwner) ? "[x]" : "[ ]";
          const cloned = localPath(repo);
          return (
            <box
              key={repo.nameWithOwner}
              flexDirection="row"
              gap={1}
              height={1}
            >
              <text
                flexShrink={0}
                fg={
                  isFocused ? theme.colors.accent : theme.colors.mutedForeground
                }
              >
                {`${isFocused ? "▸" : " "}${mark}`}
              </text>
              <box width={30} flexShrink={0}>
                <text
                  attributes={isFocused ? BOLD : undefined}
                  fg={
                    cloned
                      ? theme.colors.foreground
                      : theme.colors.mutedForeground
                  }
                  truncate
                  wrapMode="none"
                >
                  {withoutOwner(repo.nameWithOwner, snapshot?.viewer ?? "")}
                </text>
              </box>
              <box width={7} flexShrink={0}>
                <text fg={theme.colors.error}>
                  {repo.vulnCount > 0 ? `⚠ ${repo.vulnCount}` : ""}
                </text>
              </box>
              <box width={5} flexShrink={0}>
                <text fg={theme.colors.info}>
                  {repo.openPrs > 0 ? `${repo.openPrs} PR` : ""}
                </text>
              </box>
              <box width={4} flexShrink={0}>
                <text fg={theme.colors.warning}>
                  {needsRelease(repo) ? "bump" : ""}
                </text>
              </box>
              <box width={5} flexShrink={0}>
                <text fg={theme.colors.mutedForeground}>
                  {relative(repo.lastActivityAt ?? repo.pushedAt)}
                </text>
              </box>
              <text fg={theme.colors.mutedForeground} wrapMode="none" truncate>
                {tags(repo, cloned)}
              </text>
            </box>
          );
        })}
      </scrollbox>

      <box flexDirection="column" flexShrink={0}>
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
                // ◉ rather than 👁: the bare eye codepoint measures 1 cell but renders as a
                // two-cell emoji in Warp, so it ate the watcher count and flickered on every
                // re-render. The other two marks are BMP symbols and measure what they draw.
                key: "stats",
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
          <text fg={theme.colors.mutedForeground}>
            no repos match this filter
          </text>
        )}

        <box marginTop={1}>
          {status.kind === "busy" ? <Spinner label={status.label} /> : null}
          {status.kind === "error" ? (
            <Alert variant="error">{status.message}</Alert>
          ) : null}
          {status.kind === "idle" ? (
            <text fg={theme.colors.mutedForeground}>
              space select · o open · c clone · g agent · p PRs · s sort · f
              filter · x archived · ? help · q quit
            </text>
          ) : null}
        </box>
      </box>

      {overlay === "help"
        ? modal(
            "maintainer",
            "j/k to scroll · q to close",
            <>
              <KeyboardShortcuts shortcuts={SHORTCUTS} columns={2} />
              <box marginTop={1}>
                <text fg={theme.colors.mutedForeground}>
                  {`open target: ${config.app} · ${config.mode}${
                    config.command ? ` · runs ${config.command}` : ""
                  }${
                    config.command && !supportsCommand(config)
                      ? " (ignored — app cannot run commands)"
                      : ""
                  }`}
                </text>
              </box>
            </>,
          )
        : null}

      {overlay === "agent"
        ? modal(
            `${config.agent} · ${focused?.nameWithOwner ?? ""}`,
            "j/k to scroll · q to close",
            <>
              {agentOutput ? (
                <text>{agentOutput}</text>
              ) : (
                <Spinner label="thinking" />
              )}
            </>,
          )
        : null}

      {overlay === "prs"
        ? modal(
            queue.length > 0
              ? `pull requests · ${queue.filter((pr) => !pr.isDraft).length} ready, ${queue.filter((pr) => pr.isDraft).length} draft`
              : "pull requests",
            "j/k move · o open · q close",
            queue.length > 0 ? (
              queue.map((pr, position) => {
                const isFocused = position === prIndex;
                return (
                  <box
                    key={pr.url}
                    flexDirection="row"
                    gap={1}
                    height={1}
                    flexShrink={0}
                  >
                    <text
                      flexShrink={0}
                      fg={
                        isFocused
                          ? theme.colors.accent
                          : theme.colors.mutedForeground
                      }
                    >
                      {isFocused ? "▸" : " "}
                    </text>
                    <box width={34} flexShrink={0}>
                      <text
                        attributes={isFocused ? BOLD : undefined}
                        fg={theme.colors.foreground}
                        truncate
                        wrapMode="none"
                      >
                        {prLabel(pr, snapshot?.viewer ?? "")}
                      </text>
                    </box>
                    <box width={7} flexShrink={0}>
                      <text fg={theme.colors.warning}>
                        {pr.waitingOnReview ? "review" : ""}
                      </text>
                    </box>
                    <box width={6} flexShrink={0}>
                      <text fg={theme.colors.mutedForeground}>
                        {pr.isDraft ? "draft" : ""}
                      </text>
                    </box>
                    <box width={5} flexShrink={0}>
                      <text fg={theme.colors.mutedForeground}>
                        {relative(pr.updatedAt)}
                      </text>
                    </box>
                    <text
                      fg={theme.colors.mutedForeground}
                      truncate
                      wrapMode="none"
                    >
                      {pr.title}
                    </text>
                  </box>
                );
              })
            ) : (
              <text fg={theme.colors.mutedForeground}>
                nothing open and nothing waiting on your review
              </text>
            ),
          )
        : null}
    </box>
  );
}
