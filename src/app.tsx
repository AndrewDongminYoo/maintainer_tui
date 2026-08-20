import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliRenderEvents, createTextAttributes } from "@opentui/core";
import type { ScrollBoxRenderable, Selection } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import * as React from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Divider } from "@/components/ui/divider";
import { KeyboardShortcuts, type Shortcut } from "@/components/ui/keyboard-shortcuts";
import { Spinner } from "@/components/ui/spinner";
import { useTheme } from "@/hooks/use-theme";

import { runAgent, triagePrompt, type AgentRun } from "./agent.ts";
import type { Config } from "./config.ts";
import { writeCache } from "./config.ts";
import {
  fetchSnapshot,
  filterRepos,
  prQueue,
  releaseStatus,
  sortRepos,
  type FilterMode,
  type PrBucket,
  type Repo,
  type QueuedPr,
  type Snapshot,
  type SortMode,
} from "./github.ts";
import {
  agentCommand,
  checkoutState,
  cloneRepo,
  copyToClipboard,
  launchAll,
  openUrl,
  resolveLocal,
  scanRoots,
  supportsCommand,
  type CheckoutState,
  type LaunchResult,
} from "./local.ts";

const SORTS: SortMode[] = ["activity", "popular"];
const FILTERS: FilterMode[] = ["all", "attention", "vuln", "release"];

const BOLD = createTextAttributes({ bold: true });

const COPY_IDS = {
  detailRepo: "copy:detail:repo",
  detailLocal: "copy:detail:local",
  detailBranch: "copy:detail:branch",
  repoRow: (nameWithOwner: string): string => `copy:repo:${nameWithOwner}`,
  pr: (repository: string, number: number): string => `copy:pr:${repository}#${number}`,
} as const;

interface SemanticSelectionRenderable {
  id: string;
  x: number;
  y: number;
  hasSelection(): boolean;
}

interface SemanticSelection {
  selectedRenderables: SemanticSelectionRenderable[];
}

/**
 * Resolves a mouse selection to canonical command-ready values.
 *
 * The rendered text is deliberately not used: repo and PR labels may have
 * their owner removed or may be truncated by the terminal width.
 */
export function semanticSelectionPayload(
  selection: SemanticSelection,
  copyValues: ReadonlyMap<string, string>,
): string | null {
  const selected = selection.selectedRenderables
    .filter((renderable) => renderable.hasSelection())
    .sort((left, right) => left.y - right.y || left.x - right.x);

  if (selected.length === 0) return null;

  const values: string[] = [];

  for (const renderable of selected) {
    const value = copyValues.get(renderable.id);

    // Reject a mixed selection rather than copying decorative UI text.
    if (value === undefined) return null;

    values.push(value);
  }

  return values.join("\n");
}

export function selectionAfterOpen(
  selected: ReadonlySet<string>,
  targets: readonly { nameWithOwner: string; path?: string }[],
  results: readonly LaunchResult[],
): Set<string> {
  const openedPaths = new Set(results.filter((result) => result.ok).map((result) => result.path));
  const next = new Set(selected);

  for (const target of targets) {
    if (target.path && openedPaths.has(target.path)) next.delete(target.nameWithOwner);
  }

  return next;
}

export function selectionAfterRefresh(
  selected: ReadonlySet<string>,
  repos: readonly Pick<Repo, "nameWithOwner">[],
): Set<string> {
  const available = new Set(repos.map((repo) => repo.nameWithOwner));
  return new Set([...selected].filter((nameWithOwner) => available.has(nameWithOwner)));
}

const SHORTCUTS: Shortcut[] = [
  { key: "↑/↓ j/k", description: "move" },
  { key: "Home / End", description: "first / last" },
  { key: "PgUp / PgDn", description: "page" },
  { key: "space", description: "select" },
  { key: "a / A", description: "all / none" },
  { key: "s", description: "sort" },
  { key: "f", description: "filter" },
  { key: "/", description: "search by name" },
  { key: "x", description: "show archived" },
  { key: "o", description: "open selected" },
  { key: "O", description: "open focused on GitHub" },
  { key: "y", description: "copy focused owner/name" },
  { key: "c", description: "clone missing" },
  { key: "g", description: "agent triage" },
  { key: "p", description: "pull requests" },
  { key: "r", description: "refresh" },
  { key: "?", description: "help" },
  { key: "q", description: "quit" },
];

const PR_TABS: readonly PrBucket[] = ["authored", "assigned", "reviewRequested"];

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
  return nameWithOwner.startsWith(own) ? nameWithOwner.slice(own.length) : nameWithOwner;
}

/**
 * Case-insensitive substring match over the whole `owner/name`.
 *
 * The owner is matched even though the row usually hides it: the three repositories here that
 * somebody else owns are exactly the ones you would go looking for by owner.
 */
export function matchesQuery(repo: Repo, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || repo.nameWithOwner.toLowerCase().includes(needle);
}

/**
 * Working-copy state excluding the branch name.
 *
 * Kept separate so the branch can be its own selectable renderable while the
 * explanatory status remains ordinary UI text.
 */
export function checkoutStatus(state: CheckoutState | null): string {
  if (!state) return "";

  const parts: string[] = [];

  if (state.dirty > 0) parts.push(`${state.dirty} changed`);

  if (!state.tracked) {
    parts.push("no upstream");
  } else if (state.ahead > 0 || state.behind > 0) {
    if (state.ahead > 0) parts.push(`${state.ahead} unpushed`);
    if (state.behind > 0) parts.push(`${state.behind} behind`);
    parts.push("since last fetch");
  } else if (state.dirty === 0) {
    parts.push("clean");
  }

  return parts.join(" · ");
}

export function checkoutSummary(state: CheckoutState | null): string {
  if (!state) return "";

  const status = checkoutStatus(state);
  return status ? `${state.branch} · ${status}` : state.branch;
}

/**
 * A column that stops at the content it actually holds rather than filling the width, and gives
 * ground once there is not enough of it.
 *
 * Filling would push everything to its right out to the far edge and turn a row into a scanning
 * problem across a wide terminal; stopping at the longest entry keeps the columns together, and
 * tightens them when a filter shortens the list.
 */
function fittedWidth(longest: number, available: number, floor: number): number {
  return Math.max(floor, Math.min(longest, available));
}

/** Every cell on a listing row but the name and the tags: marker, signals, gaps, padding, bar. */
const ROW_CHROME = 4 + 7 + 5 + 4 + 5 + 8 + 2 + 1;
/** `fork · archived · not cloned` — the widest the tag column ever needs. */
const TAGS_WIDTH = 28;

/** Everything on a PR row but the label and the title, including the modal's own inset. */
const PANEL_CHROME = 8 + 2 + 2 + 1 + 1 + 7 + 6 + 5 + 5;
/** The title is why a PR row is worth reading, so it keeps at least this much. */
const TITLE_WIDTH = 24;

/** Fixed at 30, this truncated `credit_card_type_detector_korean` on a 215-column terminal. */
export function nameColumnWidth(longest: number, terminalWidth: number): number {
  return fittedWidth(longest, terminalWidth - ROW_CHROME - TAGS_WIDTH, 18);
}

/** The same, for `repo#number` in the pull request panel. */
export function prLabelWidth(longest: number, terminalWidth: number): number {
  return fittedWidth(longest, terminalWidth - PANEL_CHROME - TITLE_WIDTH, 16);
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

interface DetailRowProps {
  label: string;
  children: React.ReactNode;
}

function DetailRow({ label, children }: DetailRowProps): React.ReactNode {
  const theme = useTheme();

  return (
    <box flexDirection="row" gap={1}>
      <box width={9} flexShrink={0}>
        <text selectable={false} fg={theme.colors.mutedForeground}>
          {label}
        </text>
      </box>

      <text selectable={false} fg={theme.colors.mutedForeground}>
        :
      </text>

      <box flexDirection="row" flexShrink={1}>
        {children}
      </box>
    </box>
  );
}

type Status =
  { kind: "idle" } | { kind: "busy"; label: string } | { kind: "error"; message: string };

export interface AppProps {
  config: Config;
  initial: Snapshot | null;
  openExternal?: typeof openUrl;
  copyText?: typeof copyToClipboard;
}

export function App({
  config,
  initial,
  openExternal = openUrl,
  copyText = copyToClipboard,
}: AppProps): React.ReactNode {
  const renderer = useRenderer();
  const theme = useTheme();

  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(initial);
  const [status, setStatus] = React.useState<Status>(
    initial ? { kind: "idle" } : { kind: "busy", label: "querying GitHub" },
  );
  const [locals, setLocals] = React.useState<Map<string, string>>(() => scanRoots(config.roots));
  const [sort, setSort] = React.useState<SortMode>("activity");
  const [filter, setFilter] = React.useState<FilterMode>("all");
  const [showArchived, setShowArchived] = React.useState(false);
  const [cursor, setCursor] = React.useState(0);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [overlay, setOverlay] = React.useState<"none" | "help" | "agent" | "prs">("none");
  const [prTab, setPrTab] = React.useState<PrBucket>("authored");
  const [prCursor, setPrCursor] = React.useState(0);
  const [query, setQuery] = React.useState("");
  /**
   * Whether keystrokes are going into the query. The filter outlives the typing.
   *
   * The ref is what the key handler branches on, and the state is only for rendering. Typing
   * `/name` fast enough delivers the whole string in one tick, and a handler reading the state
   * would still see `false` for every character after the slash — which ran them as commands.
   * `f` cycled the filter and `o` opened a window before this was a ref.
   */
  const searchingRef = React.useRef(false);
  const [searching, setSearching] = React.useState(false);
  const setSearchMode = (on: boolean): void => {
    searchingRef.current = on;
    setSearching(on);
  };
  const [agentOutput, setAgentOutput] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const [copiedRepo, setCopiedRepo] = React.useState<string | null>(null);
  const agentRun = React.useRef<AgentRun | null>(null);
  const listRef = React.useRef<ScrollBoxRenderable>(null);
  const modalRef = React.useRef<ScrollBoxRenderable>(null);

  // Archived repos are read-only history that never needs maintaining, so they are out of the
  // pool before any filter runs rather than being one more filter mode.
  const visible = React.useMemo(
    () =>
      sortRepos(
        filterRepos(
          (snapshot?.repos ?? []).filter(
            (r) => (showArchived || !r.isArchived) && matchesQuery(r, query),
          ),
          filter,
        ),
        sort,
      ),
    [snapshot, filter, sort, showArchived, query],
  );

  const queue = React.useMemo(
    () => (snapshot ? prQueue(snapshot.attention, prTab) : []),
    [snapshot, prTab],
  );
  const prIndex = Math.min(prCursor, Math.max(queue.length - 1, 0));
  const prTabOptions = React.useMemo(
    () => [
      {
        name: `Authored (${snapshot?.attention.authored.length ?? 0})`,
        description: "",
      },
      {
        name: `Assigned (${snapshot?.attention.assigned.length ?? 0})`,
        description: "",
      },
      {
        name: `Review requests (${snapshot?.attention.reviewRequested.length ?? 0})`,
        description: "",
      },
    ],
    [snapshot],
  );

  // Keep the cursor inside the list when a filter shrinks it.
  const index = Math.min(cursor, Math.max(visible.length - 1, 0));
  const focused: Repo | undefined = visible[index];
  const focusedReleaseStatus = focused ? releaseStatus(focused) : "none";
  const localPath = (repo: Repo): string | undefined => resolveLocal(locals, repo.nameWithOwner);

  // Read for the focused repo only. Running it across all 70 checkouts would cost well over a
  // second on every cursor move, and 69 of those answers would never be looked at.
  const [checkout, setCheckout] = React.useState<CheckoutState | null>(null);
  const focusedPath = focused ? localPath(focused) : undefined;
  React.useEffect(() => {
    setCopiedRepo(null);
  }, [focused?.nameWithOwner]);

  React.useEffect(() => {
    setCheckout(null);
    if (!focusedPath) return;
    let live = true;
    void checkoutState(focusedPath).then(
      (state) => {
        if (live) setCheckout(state);
      },
      // A path that is not a repo any more is not worth an error banner; the row already says
      // whether it is cloned.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [focusedPath]);

  const copyValues = React.useMemo(() => {
    const values = new Map<string, string>();

    for (const repo of visible) {
      values.set(COPY_IDS.repoRow(repo.nameWithOwner), repo.nameWithOwner);
    }

    if (focused) {
      values.set(COPY_IDS.detailRepo, focused.nameWithOwner);
    }

    if (focusedPath) {
      values.set(COPY_IDS.detailLocal, focusedPath);
    }

    if (checkout) {
      values.set(COPY_IDS.detailBranch, checkout.branch);
    }

    for (const pr of queue) {
      values.set(COPY_IDS.pr(pr.repository, pr.number), `${pr.repository}#${pr.number}`);
    }

    return values;
  }, [visible, focused, focusedPath, checkout, queue]);

  React.useEffect(() => {
    const handleSelection = (selection: Selection): void => {
      const payload = semanticSelectionPayload(selection, copyValues);
      if (payload === null) return;

      void copyToClipboard(payload).catch((error: Error) => {
        setStatus({
          kind: "error",
          message: `copy failed: ${error.message}`,
        });
      });
    };

    renderer.on(CliRenderEvents.SELECTION, handleSelection);
    return () => {
      renderer.off(CliRenderEvents.SELECTION, handleSelection);
    };
  }, [renderer, copyValues]);

  const { width } = useTerminalDimensions();
  const nameWidth = React.useMemo(
    () =>
      nameColumnWidth(
        visible.reduce(
          (longest, repo) =>
            Math.max(longest, withoutOwner(repo.nameWithOwner, snapshot?.viewer ?? "").length),
          0,
        ),
        width,
      ),
    [visible, width, snapshot],
  );

  const prLabelColumn = React.useMemo(
    () =>
      prLabelWidth(
        queue.reduce(
          (longest, pr) => Math.max(longest, prLabel(pr, snapshot?.viewer ?? "").length),
          0,
        ),
        width,
      ),
    [queue, width, snapshot],
  );

  const move = stepper(setCursor, visible.length);
  const movePr = stepper(setPrCursor, queue.length);

  // The scrollbox scrolls itself for the wheel but knows nothing about the cursor, and a filter
  // that shortens the list can leave it parked past the end.
  React.useEffect(() => {
    const box = listRef.current;
    const viewport = box?.viewport.height ?? 0;
    if (!box || viewport <= 0) return;
    box.scrollTop = Math.min(box.scrollTop, Math.max(0, visible.length - viewport));
    if (index < box.scrollTop) box.scrollTop = index;
    else if (index >= box.scrollTop + viewport) box.scrollTop = index - viewport + 1;
  }, [index, visible.length]);

  const refresh = React.useCallback(async () => {
    setStatus({ kind: "busy", label: "querying GitHub" });
    try {
      const next = await fetchSnapshot();
      writeCache(next);
      setSnapshot(next);
      setSelected((previous) => selectionAfterRefresh(previous, next.repos));
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
  const visibleNames = new Set(visible.map((repo) => repo.nameWithOwner));
  const hiddenSelectionCount = selectedRepos.filter(
    (repo) => !visibleNames.has(repo.nameWithOwner),
  ).length;
  const selectedOpenCount = selectedRepos.filter((repo) => localPath(repo)).length;
  const selectedCloneCount = selectedRepos.length - selectedOpenCount;
  const selectionClearHint = query ? "A clear · esc clear search" : "A/esc clear";
  const selectionHint = `${selectedRepos.length} selected${hiddenSelectionCount > 0 ? ` · ${hiddenSelectionCount} hidden` : ""} · ${selectionClearHint} · o open ${selectedOpenCount} · c clone ${selectedCloneCount}`;
  const focusedHint = focused
    ? `space select · ${focusedPath ? "o open focused" : "c clone focused"}`
    : "no matching repos";
  const focusedActionsHint = focused ? " · O GitHub · y copy" : "";
  const actionHint =
    selectedRepos.length > 0
      ? `${selectionHint}${focusedActionsHint} · / search · ? help · q quit`
      : `${focusedHint}${focusedActionsHint} · r refresh · x archived · g agent · p PRs · / search · s sort · f filter · ? help · q quit`;
  const footerHint = copiedRepo ? `copied ${copiedRepo} · ${actionHint}` : actionHint;

  const open = React.useCallback(async () => {
    const targets = selectedRepos.length > 0 ? selectedRepos : focused ? [focused] : [];
    const resolvedTargets = targets.map((repo) => ({
      nameWithOwner: repo.nameWithOwner,
      path: localPath(repo),
    }));
    const paths = resolvedTargets
      .map((target) => target.path)
      .filter((p): p is string => Boolean(p));
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
    if (selectedRepos.length > 0) {
      setSelected((previous) => selectionAfterOpen(previous, resolvedTargets, results));
    }
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
    const targets = (selectedRepos.length > 0 ? selectedRepos : focused ? [focused] : []).filter(
      (r) => !localPath(r),
    );
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
        setLocals((prev) => new Map(prev).set(repo.nameWithOwner.toLowerCase(), path));
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

  const openFocusedExternal = React.useCallback(async () => {
    if (!focused) return;
    setStatus({ kind: "busy", label: `opening ${focused.nameWithOwner} in browser` });
    try {
      await openExternal(focused.url);
      setStatus({ kind: "idle" });
    } catch (error) {
      setStatus({ kind: "error", message: (error as Error).message });
    }
  }, [focused, openExternal]);

  const copyFocused = React.useCallback(async () => {
    if (!focused) return;
    try {
      await copyText(focused.nameWithOwner);
      setCopiedRepo(focused.nameWithOwner);
      setStatus({ kind: "idle" });
    } catch (error) {
      setCopiedRepo(null);
      setStatus({ kind: "error", message: (error as Error).message });
    }
  }, [focused, copyText]);

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

  /**
   * Reopens the triaged repo in a real window with the agent already running.
   *
   * The overlay holds a transcript, not a session — `runAgent` spawns a one-shot turn and the
   * child has already exited by the time it is readable. So this is a fresh conversation in the
   * right directory rather than a resumed one, which is the honest version of "continue".
   */
  const continueElsewhere = React.useCallback(
    async (seed: boolean) => {
      const path = focused ? localPath(focused) : undefined;
      if (!path || !focused) return;

      // The seed goes through a file rather than the command line: the reply is multi-line and
      // an AppleScript string literal cannot span lines.
      let promptFile: string | undefined;
      if (seed) {
        promptFile = join(tmpdir(), `maintainer-triage-${process.pid}.md`);
        writeFileSync(
          promptFile,
          `${triagePrompt(focused)}\n\n---\n\nA previous run answered:\n\n${agentOutput}\n\nPick up from there.\n`,
        );
      }

      const [result] = await launchAll([path], {
        ...config,
        command: agentCommand(config.agent, promptFile),
        mode: "window",
      });
      setStatus(
        result?.ok
          ? {
              kind: "busy",
              label: supportsCommand(config)
                ? `${config.agent} starting in ${config.app}${seed ? " with the reply" : ""}`
                : `${config.app} opened; it cannot start ${config.agent} for you${seed ? " — y copies the reply instead" : ""}`,
            }
          : {
              kind: "error",
              message: result?.error ?? "could not open a window",
            },
      );
    },
    [focused, config, locals, agentOutput],
  );

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
          if (key.name === "return") key.preventDefault();
          const pr = queue[prIndex];
          if (pr) void openUrl(pr.url);
        }
        return;
      }
      if (overlay === "agent" && agentOutput) {
        if (input === "y")
          void copyToClipboard(agentOutput).then(
            () => setCopied(true),
            (error: Error) => setStatus({ kind: "error", message: error.message }),
          );
        if (input === "o") void continueElsewhere(false);
        if (input === "O") void continueElsewhere(true);
      }
      const body = modalRef.current;
      if (body) {
        if (key.name === "down" || input === "j") body.scrollBy(1);
        if (key.name === "up" || input === "k") body.scrollBy(-1);
      }
      return;
    }
    // Typing a query swallows every printable key, or `j` and `q` would move and quit instead of
    // reaching the box. Return keeps the filter and hands the keys back; escape drops it.
    if (searchingRef.current) {
      if (key.name === "escape") {
        setQuery("");
        setSearchMode(false);
      } else if (key.name === "return") {
        setSearchMode(false);
      } else if (key.name === "backspace") {
        setQuery((previous) => previous.slice(0, -1));
        setCursor(0);
      } else if (input >= " ") {
        setQuery((previous) => previous + input);
        setCursor(0);
      }
      return;
    }
    if (input === "q" || (key.ctrl && key.name === "c")) {
      renderer.destroy();
      process.exit(0);
    }
    if (input === "/") {
      setSearchMode(true);
      return;
    }
    if (key.name === "escape") {
      if (query) {
        setQuery("");
        setCursor(0);
      } else {
        setSelected(new Set());
      }
      return;
    }
    if (key.name === "down" || input === "j") move(1);
    if (key.name === "up" || input === "k") move(-1);
    if (key.name === "home") setCursor(0);
    if (key.name === "end") setCursor(Math.max(visible.length - 1, 0));
    if (key.name === "pagedown") {
      move(Math.max(1, Math.round((listRef.current?.viewport.height ?? 0) / 2)));
    }
    if (key.name === "pageup") {
      move(-Math.max(1, Math.round((listRef.current?.viewport.height ?? 0) / 2)));
    }
    if (input === " " && focused) {
      const name = focused.nameWithOwner;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
    }
    if (input === "a") setSelected(new Set(visible.map((r) => r.nameWithOwner)));
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
    if (input === "O") void openFocusedExternal();
    if (input === "y") void copyFocused();
    if (input === "c") void clone();
    if (input === "g") void triage();
    if (input === "r") void refresh();
    if (input === "?") setOverlay("help");
    if (input === "p") {
      setPrTab("authored");
      setPrCursor(0);
      setOverlay("prs");
    }
  });

  // One scrollbox serves every overlay, so its offset survives a close. Without this, scrolling a
  // triage reply and then opening the PR panel drops the viewer into the middle of the queue.
  React.useEffect(() => {
    if (modalRef.current) modalRef.current.scrollTop = 0;
    setCopied(false);
  }, [overlay, prTab]);

  // The panel's viewport follows its cursor, the same way the listing's does.
  React.useEffect(() => {
    const box = modalRef.current;
    const viewport = box?.viewport.height ?? 0;
    if (!box || viewport <= 0 || overlay !== "prs") return;
    if (prIndex < box.scrollTop) box.scrollTop = prIndex;
    else if (prIndex >= box.scrollTop + viewport) box.scrollTop = prIndex - viewport + 1;
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
    header?: React.ReactNode,
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
      {header}
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
          <text fg={theme.colors.secondaryForeground}>{`filter:${filter}`}</text>
          {query || searching ? (
            <text fg={searching ? theme.colors.accent : theme.colors.secondaryForeground}>
              {`/${query}${searching ? "_" : ""}`}
            </text>
          ) : null}
          {showArchived ? <text fg={theme.colors.secondaryForeground}>+archived</text> : null}
          {selectedRepos.length > 0 ? (
            <Badge variant="info">{`${selectedRepos.length} selected`}</Badge>
          ) : null}
        </box>

        {snapshot ? (
          <box flexDirection="row" gap={1}>
            <text fg={theme.colors.mutedForeground}>
              {`authored: ${snapshot.attention.authored.length} · assigned: ${snapshot.attention.assigned.length} · review requested: ${snapshot.attention.reviewRequested.length} · fetched ${since(snapshot.fetchedAt)}`}
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
          const repoReleaseStatus = releaseStatus(repo);
          return (
            <box key={repo.nameWithOwner} flexDirection="row" gap={1} height={1}>
              <text
                selectable={false}
                flexShrink={0}
                fg={isFocused ? theme.colors.accent : theme.colors.mutedForeground}
              >
                {`${isFocused ? "▸" : " "}${mark}`}
              </text>
              <box width={nameWidth} flexShrink={0}>
                <text
                  id={COPY_IDS.repoRow(repo.nameWithOwner)}
                  selectable
                  attributes={isFocused ? BOLD : undefined}
                  fg={cloned ? theme.colors.foreground : theme.colors.mutedForeground}
                  truncate
                  wrapMode="none"
                >
                  {withoutOwner(repo.nameWithOwner, snapshot?.viewer ?? "")}
                </text>
              </box>
              <box width={7} flexShrink={0}>
                <text selectable={false} fg={theme.colors.error}>
                  {repo.vulnCount > 0 ? `⚠ ${repo.vulnCount}` : ""}
                </text>
              </box>
              <box flexDirection="row" gap={2} flexShrink={0}>
                <box width={5} flexShrink={0}>
                  <text selectable={false} fg={theme.colors.info}>
                    {repo.openPrs > 0 ? `${repo.openPrs} PR` : ""}
                  </text>
                </box>
                <box width={4} flexShrink={0}>
                  <text selectable={false} fg={theme.colors.warning}>
                    {repoReleaseStatus === "unreleased"
                      ? "bump"
                      : repoReleaseStatus === "unknown"
                        ? "?"
                        : ""}
                  </text>
                </box>
                <box width={5} flexShrink={0}>
                  <text selectable={false} fg={theme.colors.mutedForeground}>
                    {relative(repo.lastActivityAt ?? repo.pushedAt)}
                  </text>
                </box>
              </box>
              <text selectable={false} fg={theme.colors.mutedForeground} wrapMode="none" truncate>
                {tags(repo, cloned)}
              </text>
            </box>
          );
        })}
      </scrollbox>

      <box flexDirection="column" flexShrink={0}>
        <Divider />

        {focused ? (
          <box flexDirection="column">
            <DetailRow label="repo">
              <text id={COPY_IDS.detailRepo} selectable fg={theme.colors.foreground}>
                {focused.nameWithOwner}
              </text>

              {focused.isArchived ? (
                <text selectable={false} fg={theme.colors.foreground}>
                  {" (archived)"}
                </text>
              ) : null}
            </DetailRow>

            <DetailRow label="stats">
              <text selectable={false} fg={theme.colors.foreground}>
                {`stars ${focused.stars} forks ${focused.forks} watchers ${focused.watchers} · ${focused.language ?? "—"}`}
              </text>
            </DetailRow>

            <DetailRow label="release">
              <text selectable={false} fg={theme.colors.foreground}>
                {focused.latestRelease
                  ? `${focused.latestRelease.tagName}${
                      focusedReleaseStatus === "unreleased"
                        ? " · unreleased commits on default branch"
                        : focusedReleaseStatus === "unknown"
                          ? " · comparison unavailable"
                          : " · up to date"
                    }`
                  : "none published"}
              </text>
            </DetailRow>

            <DetailRow label="local">
              <text
                id={focusedPath ? COPY_IDS.detailLocal : undefined}
                selectable={Boolean(focusedPath)}
                fg={focusedPath ? theme.colors.foreground : theme.colors.mutedForeground}
              >
                {focusedPath ?? "not cloned"}
              </text>
            </DetailRow>

            {checkout ? (
              <DetailRow label="working">
                <text id={COPY_IDS.detailBranch} selectable fg={theme.colors.foreground}>
                  {checkout.branch}
                </text>

                {checkoutStatus(checkout) ? (
                  <text selectable={false} fg={theme.colors.foreground}>
                    {` · ${checkoutStatus(checkout)}`}
                  </text>
                ) : null}
              </DetailRow>
            ) : null}
          </box>
        ) : (
          <text selectable={false} fg={theme.colors.mutedForeground}>
            no repos match this filter
          </text>
        )}

        <box marginTop={1}>
          {status.kind === "busy" ? <Spinner label={status.label} /> : null}
          {status.kind === "error" ? <Alert variant="error">{status.message}</Alert> : null}
          {status.kind === "idle" && searching ? (
            <text fg={theme.colors.accent}>searching · return keeps the filter · esc drops it</text>
          ) : null}
          {status.kind === "idle" && !searching ? (
            <text fg={theme.colors.mutedForeground}>{footerHint}</text>
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
            agentOutput
              ? `${copied ? "copied · " : ""}y copy · o new · O new with reply · j/k scroll · q close`
              : "q to cancel",
            <>{agentOutput ? <text>{agentOutput}</text> : <Spinner label="thinking" />}</>,
          )
        : null}

      {overlay === "prs"
        ? modal(
            queue.length > 0
              ? `pull requests · ${queue.filter((pr) => !pr.isDraft).length} ready, ${queue.filter((pr) => pr.isDraft).length} draft`
              : "pull requests",
            "←/→ or [/] tabs · j/k move · o open · q close",
            queue.length > 0 ? (
              queue.map((pr, position) => {
                const isFocused = position === prIndex;
                return (
                  <box
                    key={`${pr.repository}#${pr.number}`}
                    flexDirection="row"
                    gap={1}
                    height={1}
                    flexShrink={0}
                  >
                    <text
                      flexShrink={0}
                      fg={isFocused ? theme.colors.accent : theme.colors.mutedForeground}
                    >
                      {isFocused ? "▸" : " "}
                    </text>
                    <box width={prLabelColumn} flexShrink={0}>
                      <text
                        id={COPY_IDS.pr(pr.repository, pr.number)}
                        selectable
                        attributes={isFocused ? BOLD : undefined}
                        fg={theme.colors.foreground}
                        truncate
                        wrapMode="none"
                      >
                        {prLabel(pr, snapshot?.viewer ?? "")}
                      </text>
                    </box>
                    <box width={7} flexShrink={0}>
                      <text fg={theme.colors.warning}>{pr.waitingOnReview ? "review" : ""}</text>
                    </box>
                    <box width={6} flexShrink={0}>
                      <text fg={theme.colors.mutedForeground}>{pr.isDraft ? "draft" : ""}</text>
                    </box>
                    <box width={5} flexShrink={0}>
                      <text fg={theme.colors.mutedForeground}>{relative(pr.updatedAt)}</text>
                    </box>
                    <text fg={theme.colors.mutedForeground} truncate wrapMode="none">
                      {pr.title}
                    </text>
                  </box>
                );
              })
            ) : (
              <text fg={theme.colors.mutedForeground}>no pull requests in this tab</text>
            ),
            <tab-select
              focused
              height={1}
              flexShrink={0}
              marginBottom={1}
              options={prTabOptions}
              tabWidth={22}
              showDescription={false}
              showScrollArrows
              wrapSelection={false}
              backgroundColor={theme.colors.background}
              textColor={theme.colors.mutedForeground}
              focusedBackgroundColor={theme.colors.selection}
              focusedTextColor={theme.colors.selectionForeground}
              selectedBackgroundColor={theme.colors.accent}
              selectedTextColor={theme.colors.accentForeground}
              onChange={(index) => {
                const next = PR_TABS[index];
                if (!next) return;
                setPrTab(next);
                setPrCursor(0);
              }}
            />,
          )
        : null}
    </box>
  );
}
