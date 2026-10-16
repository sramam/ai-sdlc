/**
 * The shape of `sdlc.config.ts` and the one loader every script uses.
 *
 * A project changes the tooling's behaviour here and nowhere else: the
 * packages under `tooling/` are upstream-owned (docs/kit/starter-repo.md).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** When a CI step applies. A step that does not apply prints `n/a`, never a pass. */
export type Applies = "always" | "has-apps" | "has-packages" | "has-source" | "has-plan";

export interface CiStep {
  name: string;
  /** Shell command, run from the repository root in a scrubbed environment. */
  run: string;
  applies: Applies;
  /** Environment variables the step may see. Everything else is removed. */
  env?: string[];
}

export interface Account {
  name: string;
  /** The CLI binary, or null when the vendor has none (a manual step). */
  cli: string | null;
  /** Non-interactive arguments that print the identity, e.g. ["whoami"]. */
  check: string[];
  /** For a vendor with no CLI: the documented manual step and its owner. */
  manual?: string;
}

/** The starter's tooling modules, one workspace package each under tooling/. */
export const STARTER_MODULES = ["core", "guards", "plan", "ci", "setup", "journeys"];

/** Skills the starter ships, upstream-owned like the modules. */
export const STARTER_SKILLS = [
  "kickoff",
  "idea",
  "add-requirement",
  "plan",
  "land",
  "handoff",
  "pickup",
  "progress-report",
  "commit-reviewer",
  "code-reviewer",
];

/**
 * The paths a project never edits in place: `pnpm sdlc:update` overwrites them,
 * and the commit hook warns when one changes. A module the project has taken
 * over (`modules.replaced`) is the project's from then on, and leaves this list.
 */
export function upstreamPaths(replaced: string[] = []): string[] {
  return [
    ...STARTER_MODULES.filter((m) => !replaced.includes(m)).map((m) => `tooling/${m}/`),
    "docs/kit/",
    ...STARTER_SKILLS.map((s) => `.claude/skills/${s}/`),
  ];
}

export interface SdlcConfig {
  branches: { integration: string; staging: string; production: string };
  dirs: { requirements: string; plan: string; progress: string; adr: string; handoffs: string };
  /** Days without a commit before a claimed branch is reported as stale. */
  claimStaleDays: number;
  cadence: { progressReportWeekdays: number[]; planSyncDays: number };
  accounts: Account[];
  ci: { steps: CiStep[] };
  /** Per-path coverage floors; empty until there is code to cover. */
  coverage: { floors: Record<string, { lines: number; branches: number }> };
  /**
   * Modules (tooling/<name>) the project has replaced with its own. They stop
   * being upstream-owned: sdlc:update skips them and the commit hook stops
   * warning. Removing a module entirely also means removing its hooks from
   * .claude/settings.json and .husky/, and its steps from ci.steps.
   */
  modules?: { replaced: string[] };
}

export function defineConfig(config: SdlcConfig): SdlcConfig {
  return config;
}

/** Walk up from `start` to the directory holding `sdlc.config.ts`. */
export function findRoot(start: string = process.cwd()): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "sdlc.config.ts"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadConfig(root: string): Promise<SdlcConfig> {
  const mod = (await import(pathToFileURL(join(root, "sdlc.config.ts")).href)) as {
    default: SdlcConfig;
  };
  return mod.default;
}
