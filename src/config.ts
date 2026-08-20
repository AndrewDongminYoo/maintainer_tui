import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type OpenMode = "window" | "tab";
export type AgentName = "claude" | "codex";

export interface Config {
  /** Absolute directories scanned for existing clones. The cwd is always searched first. */
  roots: string[];
  /** Where `clone` puts repos that are missing locally. */
  cloneRoot: string;
  /** macOS application name passed to `open -a`, or a known terminal with a richer strategy. */
  app: string;
  mode: OpenMode;
  /** Shell command run in each opened tab/window. Only iTerm and Terminal can honour this. */
  command: string | null;
  agent: AgentName;
}

const DEFAULT_ROOT = join(homedir(), "Development");

export const CONFIG_PATH = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "maintainer-tui",
  "config.json",
);

export const CACHE_PATH = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "maintainer-tui",
  "repos.json",
);

const DEFAULTS: Config = {
  roots: [DEFAULT_ROOT],
  cloneRoot: DEFAULT_ROOT,
  app: "Warp",
  mode: "tab",
  command: null,
  agent: "claude",
};

export function loadConfig(): Config {
  let user: Partial<Config> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      user = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
    } catch (error) {
      throw new Error(`${CONFIG_PATH} is not valid JSON: ${(error as Error).message}`);
    }
  }
  const merged = { ...DEFAULTS, ...user };
  merged.roots = [...new Set([...implicitRoots(), ...merged.roots])];
  return merged;
}

// cspell:words unconfigured
/**
 * The current directory takes precedence over configured roots. When it is itself a checkout,
 * its parent is searched too — standing inside one project means the sibling directories are
 * almost always the rest of the dev tree, which is what makes the tool useful unconfigured.
 */
function implicitRoots(): string[] {
  const cwd = process.cwd();
  const roots = [cwd];
  if (existsSync(join(cwd, ".git"))) roots.push(dirname(cwd));
  return roots;
}

export function saveConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

export function writeCache(payload: unknown): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(payload));
}

export function readCache<T>(maxAgeMs: number): T | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as {
      fetchedAt: number;
    } & T;
    if (Date.now() - raw.fetchedAt > maxAgeMs) return null;
    return raw;
  } catch {
    return null;
  }
}
