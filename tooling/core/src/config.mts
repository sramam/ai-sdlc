/**
 * The shape of `sdlc.config.json` and the one loader every script uses.
 *
 * A project configures the tooling here. It owns the packages under
 * `tooling/` too, and may change them (docs/kit/registry.md); this file is for
 * what changes between projects without changing code.
 *
 * **Declarative, never executed.** The configuration used to be a TypeScript
 * module that was `import()`ed, and ci:local imported it from the commit under
 * test — so a branch could run arbitrary code in the CI process just by
 * editing its config. It is JSON now, validated by hand against `SHAPE` below
 * (no runtime dependency: hooks run before `pnpm install`), and ci:local reads
 * its CI definition from `origin/<integration>` rather than from the branch.
 *
 * `config.schema.json` is generated from `SHAPE` (`node
 * tooling/core/src/config-schema.mts --write`) for editors; a test keeps the
 * two in agreement. Documented examples live in tooling/core/README.md, since
 * JSON has no comments.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exec as realExec } from "./exec.mts";
import type { Exec } from "./exec.mts";
import { check } from "./shape.mts";
import type { Field, Shape } from "./shape.mts";

export const CONFIG_FILE = "sdlc.config.json";

/** When a CI step applies. A step that does not apply prints `n/a`, never a pass. */
export type Applies = "always" | "has-apps" | "has-packages" | "has-source" | "has-plan";

export const APPLIES: Applies[] = ["always", "has-apps", "has-packages", "has-source", "has-plan"];

export interface CiStep {
  name: string;
  /** Shell command, run from the repository root in a scrubbed environment. */
  run: string;
  applies: Applies;
  /** Environment variables the step may see. Everything else is removed. */
  env?: string[];
  /**
   * The step reads a commit range rather than a tree, so a cached pass of the
   * tree says nothing about it: it runs on every invocation (tooling/ci).
   */
  history?: boolean;
  /**
   * Exit codes that mean the step *could not run* (a missing tool, a network
   * failure) rather than failed. Opt-in per step, because many tools use 2 for a
   * real error; the kit's own tools use 2 for could-not-run.
   */
  unknownExitCodes?: number[];
}

/** `ci:local --container`: run install and every step inside this image. */
export interface CiContainer {
  image: string;
  /** Default "docker". */
  engine?: "docker" | "podman";
  /** A `--network` value; absent means the engine's default network. */
  network?: string;
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

/**
 * The branch names are fixed. They stay in the config so every tool reads them
 * from one place, but they are not knobs: the pre-push hook, the permission
 * denies in .claude/settings.json, the skills and the journey drift default all
 * name dev, staging and main literally, and a project that renamed one would
 * have land and ci:local looking for an origin branch that does not exist.
 * Making them configurable would mean making every one of those read the
 * config first — the hook runs before `pnpm install` and a permission rule
 * cannot read a file at all — so they are refused instead of half-supported.
 */
export const FIXED_BRANCHES = {
  integration: "dev",
  staging: "staging",
  production: "main",
} as const;

/** One per-checkout PGlite database served by `pnpm db:local` (tooling/localdb). */
export interface LocaldbDatabase {
  /** A directory name under `.localdb/`: letters, digits, `-` and `_`. */
  name: string;
  /**
   * The project's command that applies its migrations, run from the repository
   * root with DATABASE_URL pointing at this database. The ORM is the project's
   * choice, so applying migrations is the project's command.
   */
  migrate?: string;
  /** Extra environment variables that also receive the URL, e.g. a Hyperdrive local connection string. */
  env?: string[];
}

/** An application that has mock data, run by `pnpm seed` (tooling/seed). */
export interface SeedApp {
  /** The name `pnpm seed <app>` selects it by. */
  app: string;
  /** Shell command, run from the repository root with SEED_* in its environment. */
  run: string;
  /** A `localdb` database whose URL becomes DATABASE_URL when the target is local. */
  database?: string;
  /** The sizes this app's seeder understands. Default ["test", "dev", "demo"]. */
  sizes?: string[];
}

/**
 * A deployed environment that `pnpm promote <name>` moves forward
 * (tooling/promote). Its `branch` is the staging or production branch; it is
 * promoted from the branch before it in `integration → staging → production`.
 */
export interface EnvironmentConfig {
  /** The git branch this environment deploys: `branches.staging` or `branches.production`. */
  branch: string;
  /** Shell command that deploys, run in a clean checkout of the promoted SHA. */
  deploy: string;
  /** Shell command that migrates this environment's database over its direct connection. Runs before deploy. */
  migrate?: string;
  /** GET after the push; any status below 400 passes. */
  smokeUrl?: string;
  /** Shell command run after the push, in the checkout; exit 0 passes. */
  smoke?: string;
  /** Shell command `pnpm rollback <name>` runs. The schema stays forward. */
  rollback?: string;
  /** Promote prints the plan and requires `--yes`. */
  requiresApproval?: boolean;
}

export interface SdlcConfig {
  /**
   * Which config format this file is written in. Default 1. A release that
   * changes the format raises it, and says how to convert in the notes
   * `pnpm sdlc update` prints for the item.
   */
  configVersion?: number;
  branches: { integration: string; staging: string; production: string };
  dirs: { requirements: string; plan: string; progress: string; adr: string; handoffs: string };
  /** Days without a commit before a claimed branch is reported as stale. */
  claimStaleDays: number;
  /** progressReportWeekdays: 0 = Sunday … 6 = Saturday. */
  cadence: { progressReportWeekdays: number[]; planSyncDays: number };
  accounts: Account[];
  ci: { steps: CiStep[]; container?: CiContainer };
  /** Per-path coverage floors; empty until there is code to cover. */
  coverage: { floors: Record<string, { lines: number; branches: number }> };
  /** Per-checkout local databases (`pnpm db:local`). Absent: none. */
  localdb?: { databases: LocaldbDatabase[] };
  /** Applications with deterministic mock data (`pnpm seed`). Absent: none. */
  seeds?: SeedApp[];
  /** Deployed environments, by name (`pnpm promote <name>`). Absent: nothing to promote. */
  environments?: Record<string, EnvironmentConfig>;
  /** Version tags (`pnpm release`). Absent: tagPrefix "v". */
  release?: { tagPrefix: string };
}

/** Kept for tests that build a config in code; the file itself is JSON. */
export function defineConfig(config: SdlcConfig): SdlcConfig {
  return config;
}

// ─── The shape (tooling/core/src/shape.mts) ───────────────────────────────────

const str: Shape = { t: "string", minLength: 1 };
const strList: Shape = { t: "array", items: str };
const req = (shape: Shape, description?: string): Field => ({ shape, description });
const opt = (shape: Shape, description?: string): Field => ({ shape, optional: true, description });
const obj = (props: Record<string, Field>): Shape => ({ t: "object", props });

export const SHAPE: Shape = obj({
  configVersion: opt(
    { t: "integer", min: 1 },
    "The config format version; default 1. A release that changes the format raises it.",
  ),
  branches: req(
    obj({
      integration: req({ t: "enum", values: [FIXED_BRANCHES.integration] }),
      staging: req({ t: "enum", values: [FIXED_BRANCHES.staging] }),
      production: req({ t: "enum", values: [FIXED_BRANCHES.production] }),
    }),
    "Branch names, fixed: dev, staging and main. Kept so tools read one source; not configurable (tooling/core/src/config.mts FIXED_BRANCHES).",
  ),
  dirs: req(
    obj({
      requirements: req(str),
      plan: req(str),
      progress: req(str),
      adr: req(str),
      handoffs: req(str),
    }),
  ),
  claimStaleDays: req(
    { t: "integer", min: 1 },
    "Days without a commit before a claimed branch is reported as stale.",
  ),
  cadence: req(
    obj({
      progressReportWeekdays: req(
        { t: "array", items: { t: "integer", min: 0, max: 6 } },
        "0 = Sunday … 6 = Saturday.",
      ),
      planSyncDays: req({ t: "integer", min: 1 }),
    }),
  ),
  accounts: req({
    t: "array",
    items: obj({
      name: req(str),
      cli: req({ t: "nullable", inner: str }, "The CLI binary, or null for a manual step."),
      check: req({ t: "array", items: { t: "string" } }),
      manual: opt(str),
    }),
  }),
  ci: req(
    obj({
      steps: req({
        t: "array",
        items: obj({
          name: req(str),
          run: req(str),
          applies: req({ t: "enum", values: APPLIES }),
          env: opt(strList, "Environment variables the step may see."),
          history: opt({ t: "boolean" }, "Reads a commit range: runs even on a cache hit."),
          unknownExitCodes: opt(
            { t: "array", items: { t: "integer", min: 1, max: 255 } },
            "Exit codes meaning the step could not run, not that it failed.",
          ),
        }),
      }),
      container: opt(
        obj({
          image: req(str),
          engine: opt({ t: "enum", values: ["docker", "podman"] }),
          network: opt(str),
        }),
        "Used by `ci:local --container`.",
      ),
    }),
  ),
  coverage: req(
    obj({
      floors: req({
        t: "record",
        values: obj({
          lines: req({ t: "number", min: 0, max: 100 }),
          branches: req({ t: "number", min: 0, max: 100 }),
        }),
      }),
    }),
  ),
  localdb: opt(
    obj({
      databases: req({
        t: "array",
        items: obj({
          name: req({ t: "string", pattern: "^[A-Za-z0-9_-]+$" }),
          migrate: opt(str),
          env: opt(strList),
        }),
      }),
    }),
  ),
  seeds: opt({
    t: "array",
    items: obj({
      app: req(str),
      run: req(str),
      database: opt(str),
      sizes: opt(strList),
    }),
  }),
  environments: opt(
    {
      t: "record",
      values: obj({
        branch: req(
          str,
          "The branch this environment deploys: branches.staging or branches.production.",
        ),
        deploy: req(str, "Shell command, run in a clean checkout of the promoted SHA."),
        migrate: opt(
          str,
          "Shell command migrating this environment over its direct connection; runs before deploy.",
        ),
        smokeUrl: opt(str, "GET after the push; a status below 400 passes."),
        smoke: opt(str, "Shell command run after the push; exit 0 passes."),
        rollback: opt(str, "Shell command for `pnpm rollback <env>`. The schema stays forward."),
        requiresApproval: opt({ t: "boolean" }, "Promote prints the plan and requires --yes."),
      }),
    },
    "Deployed environments by name, promoted with `pnpm promote <name>` (tooling/promote).",
  ),
  release: opt(
    obj({
      tagPrefix: req(
        { t: "string", pattern: "^[A-Za-z0-9._/-]*$" },
        'Prefix of version tags, e.g. "v" for v1.2.3.',
      ),
    }),
    'Version tags (`pnpm release`). Absent: tagPrefix "v".',
  ),
});

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(source: string, problems: string[]) {
    super(
      `${source} is not a valid configuration:\n  ${problems.slice(0, 20).join("\n  ")}${problems.length > 20 ? `\n  … and ${problems.length - 20} more` : ""}`,
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** Validate an already-parsed value. */
export function validateConfig(
  value: unknown,
): { ok: true; config: SdlcConfig } | { ok: false; problems: string[] } {
  // The fixed branch names get a sentence saying why, not just "expected one of".
  const problems = check(SHAPE, value).map((p) => {
    const m = /^branches\.(integration|staging|production): expected one of/.exec(p);
    if (!m) return p;
    const role = m[1] as keyof typeof FIXED_BRANCHES;
    const got = (value as { branches: Record<string, unknown> }).branches[role];
    return `branches.${role}: must be "${FIXED_BRANCHES[role]}", got ${JSON.stringify(got)} — the branch names are fixed (dev → staging → main), because the pre-push hook, the permission denies and the skills name them literally`;
  });
  if (problems.length) return { ok: false, problems };
  const config = value as SdlcConfig;
  // Cross-field: a seed's database must be a declared localdb database.
  const dbs = new Set(config.localdb?.databases.map((d) => d.name) ?? []);
  const cross = (config.seeds ?? []).flatMap((s, i) =>
    s.database !== undefined && !dbs.has(s.database)
      ? [`seeds[${i}].database: "${s.database}" is not a localdb.databases name`]
      : [],
  );
  // Cross-field: an environment deploys a branch that has a branch before it.
  const promotable = [config.branches.staging, config.branches.production];
  for (const [name, env] of Object.entries(config.environments ?? {}))
    if (!promotable.includes(env.branch))
      cross.push(
        `environments.${name}.branch: "${env.branch}" is neither branches.staging ("${config.branches.staging}") nor branches.production ("${config.branches.production}")`,
      );
  return cross.length ? { ok: false, problems: cross } : { ok: true, config };
}

/** Parse and validate JSON text; throws a ConfigError naming every problem. */
export function parseConfig(text: string, source = CONFIG_FILE): SdlcConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(source, [`not valid JSON: ${(e as Error).message}`]);
  }
  const v = validateConfig(value);
  if (!v.ok) throw new ConfigError(source, v.problems);
  return v.config;
}

/** Walk up from `start` to the directory holding `sdlc.config.json`. */
export function findRoot(start: string = process.cwd()): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The working tree's config, validated. Reads a file; never imports anything. */
export async function loadConfig(root: string): Promise<SdlcConfig> {
  return loadConfigSync(root);
}

export function loadConfigSync(root: string): SdlcConfig {
  const path = join(root, CONFIG_FILE);
  return parseConfig(readFileSync(path, "utf8"), path);
}

/**
 * The config as committed at `gitRef` (`git show <ref>:sdlc.config.json`),
 * validated. `null` when the commit has no such file — the first commit of a
 * repository, before the config existed. A ref that does not resolve, or a git
 * that cannot be asked, throws: that is not the same answer as "absent".
 */
export async function loadConfigAt(
  root: string,
  gitRef: string,
  exec: Exec = realExec,
): Promise<SdlcConfig | null> {
  const git = (args: string[]) => exec("git", args, { cwd: root, timeoutMs: 30_000 });
  const commit = await git(["rev-parse", "--verify", "--quiet", `${gitRef}^{commit}`]);
  if (commit.code !== 0 || !commit.stdout.trim())
    throw new Error(`cannot resolve ${gitRef} to a commit`);
  const sha = commit.stdout.trim();
  const has = await git(["cat-file", "-e", `${sha}:${CONFIG_FILE}`]);
  if (has.code !== 0) {
    if (has.notFound || has.timedOut) throw new Error("could not ask git");
    return null;
  }
  const shown = await git(["show", `${sha}:${CONFIG_FILE}`]);
  if (shown.code !== 0)
    throw new Error(`git show ${gitRef}:${CONFIG_FILE} failed: ${shown.stderr.trim()}`);
  return parseConfig(shown.stdout, `${CONFIG_FILE} at ${gitRef}`);
}
