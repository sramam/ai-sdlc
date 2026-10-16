/**
 * `pnpm seed [app...] [--size dev] [--target local|dev|staging] [--today YYYY-MM-DD]`
 *
 * Runs each declared application's seeder with the same inputs every time:
 * SEED_SIZE, SEED_RANDOM, SEED_TODAY, SEED_TARGET, a DATABASE_URL, and the
 * capture transports forced on whatever the environment says — a seed never
 * sends (docs/kit/data-model.md § Seed and demo data).
 *
 * Targets are an **allow-list**: local, dev, staging. Production, and any name
 * nobody declared, is refused — the set of environments nobody has thought of
 * is always the larger one. Every refusal is decided before any seeder runs.
 */
import { parseArgs } from "node:util";
import { exec as realExec, formatDuration, isEntry } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";
import { findRoot, loadConfig } from "../../core/src/config.mts";
import type { SdlcConfig, SeedApp } from "../../core/src/config.mts";
import { loopbackPort } from "../../localdb/src/lib.mts";
import { runningUrl } from "../../localdb/src/localdb.mts";
import { DEFAULT_SEED_RANDOM, parseIsoDate } from "./helpers.mts";

export const TARGETS = ["local", "dev", "staging"] as const;
export type Target = (typeof TARGETS)[number];
export const DEFAULT_SIZES = ["test", "dev", "demo"];

/** Forced on every seed run, whatever the environment says. */
export const CAPTURE_ENV = {
  EMAIL_TRANSPORT: "capture",
  STORAGE_TRANSPORT: "local",
  MODEL_TRANSPORT: "recorded",
} as const;

/** What localdb says about one database, as the planner needs it. */
export type DbAnswer =
  | { state: "running"; url: string; port: number; env: string[] }
  | { state: "stopped" | "could-not-ask" | "undeclared"; reason: string };

export interface PlanInput {
  seeds: SeedApp[];
  /** Apps named on the command line; empty means every declared one. */
  apps: string[];
  size: string;
  target: string;
  /** YYYY-MM-DD. */
  today: string;
  random: string;
  /** DATABASE_URL from the caller's environment, if any. */
  envUrl: string | undefined;
  /** localdb's answer for each database a seed names. */
  databases: Record<string, DbAnswer>;
  /** Ports of every running localdb database in this checkout. */
  localPorts: number[];
}

export interface Plan {
  app: SeedApp;
  /** Variables to set; `DATABASE_URL: undefined` means remove it. */
  env: Record<string, string | undefined>;
  /** Where DATABASE_URL came from, for the report line. */
  database: string;
}

export function plan(input: PlanInput): { plans: Plan[]; refusals: string[] } {
  const refusals: string[] = [];
  if (!(TARGETS as readonly string[]).includes(input.target)) {
    // Nothing past this can be right for a target nobody allowed; say only this.
    refusals.push(
      `target ${JSON.stringify(input.target)} is not one seeds may write to — allowed: ${TARGETS.join(", ")}` +
        (input.target === "production" ? " (production is never seeded)" : ""),
    );
    return { plans: [], refusals };
  }
  if (!parseIsoDate(input.today))
    refusals.push(`today must be YYYY-MM-DD, got ${JSON.stringify(input.today)}`);
  if (!input.random) refusals.push("the random seed is empty");

  const declared = input.seeds.map((s) => s.app);
  const unknown = input.apps.filter((a) => !declared.includes(a));
  if (unknown.length)
    refusals.push(
      `${unknown.map((a) => JSON.stringify(a)).join(", ")} ${unknown.length > 1 ? "declare" : "declares"} no seed data — configured: ${declared.join(", ")}`,
    );
  const chosen = input.apps.length
    ? input.seeds.filter((s) => input.apps.includes(s.app))
    : input.seeds;

  const envIsLocal =
    input.envUrl !== undefined && input.localPorts.includes(loopbackPort(input.envUrl) ?? -1);
  // Target local with a DATABASE_URL that is not ours is refused once, whether
  // or not an app would have overridden it: somebody set it, and silently
  // ignoring a remote URL is how the wrong database gets seeded next time.
  if (input.target === "local" && input.envUrl !== undefined && !envIsLocal) {
    refusals.push(
      "target local, but DATABASE_URL is set and is not one of this checkout's running localdb databases — unset it, or name the target it belongs to",
    );
    return { plans: [], refusals };
  }
  const plans: Plan[] = [];
  for (const app of chosen) {
    const sizes = app.sizes ?? DEFAULT_SIZES;
    if (!sizes.includes(input.size)) {
      refusals.push(
        `${app.app}: no size ${JSON.stringify(input.size)} — it declares ${sizes.join(", ")}`,
      );
      continue;
    }
    const env: Record<string, string | undefined> = {
      SEED_APP: app.app,
      SEED_SIZE: input.size,
      SEED_RANDOM: input.random,
      SEED_TODAY: input.today,
      SEED_TARGET: input.target,
      ...CAPTURE_ENV,
    };
    let database: string;
    if (input.target === "local") {
      if (app.database) {
        const answer = input.databases[app.database];
        if (!answer || answer.state !== "running") {
          const why = answer?.reason ?? "unknown";
          refusals.push(
            answer?.state === "undeclared"
              ? `${app.app}: database ${JSON.stringify(app.database)} is not in localdb.databases`
              : `${app.app}: localdb ${app.database} — ${why}${answer?.state === "stopped" ? ` (pnpm db:local start ${app.database})` : ""}`,
          );
          continue;
        }
        env.DATABASE_URL = answer.url;
        for (const name of answer.env) env[name] = answer.url;
        database = `localdb ${app.database}`;
      } else if (input.envUrl === undefined) {
        env.DATABASE_URL = undefined;
        database = "no DATABASE_URL";
      } else {
        env.DATABASE_URL = input.envUrl;
        database = "DATABASE_URL (a localdb)";
      }
    } else {
      if (envIsLocal) {
        refusals.push(
          `${app.app}: target ${input.target}, but DATABASE_URL points at this checkout's localdb — say --target local`,
        );
        continue;
      }
      if (app.database && input.envUrl === undefined) {
        refusals.push(
          `${app.app}: target ${input.target} needs DATABASE_URL for that environment in the environment`,
        );
        continue;
      }
      env.DATABASE_URL = input.envUrl;
      database = input.envUrl === undefined ? "no DATABASE_URL" : `DATABASE_URL (${input.target})`;
    }
    plans.push({ app, env, database });
  }
  return { plans, refusals };
}

export interface SeedDeps {
  root: string;
  config: SdlcConfig;
  exec: Exec;
  log: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** Injected in tests; the real one asks localdb. */
  ask?: (db: string) => Promise<DbAnswer>;
}

/** Today on this machine's calendar — what a person running the seed means by "today". */
function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export async function main(argv: string[], deps: SeedDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      size: { type: "string", default: "dev" },
      target: { type: "string", default: "local" },
      today: { type: "string" },
      random: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    deps.log(
      "usage: pnpm seed [app...] [--size test|dev|demo] [--target local|dev|staging] [--today YYYY-MM-DD]",
    );
    return 0;
  }
  const seeds = deps.config.seeds ?? [];
  if (!seeds.length) {
    deps.log(
      "no application declares seed data — add `seeds` to sdlc.config.json (see tooling/seed/README.md)",
    );
    return 0;
  }

  const localdbs = deps.config.localdb?.databases ?? [];
  const ask =
    deps.ask ??
    (async (name: string): Promise<DbAnswer> => {
      const db = localdbs.find((d) => d.name === name);
      if (!db) return { state: "undeclared", reason: "not declared" };
      const r = await runningUrl(deps.root, name);
      return r.state === "running" ? { ...r, env: db.env ?? [] } : r;
    });
  const databases: Record<string, DbAnswer> = {};
  const localPorts: number[] = [];
  for (const name of new Set([
    ...localdbs.map((d) => d.name),
    ...seeds.flatMap((s) => (s.database ? [s.database] : [])),
  ])) {
    databases[name] = await ask(name);
    const a = databases[name];
    if (a.state === "running") localPorts.push(a.port);
  }

  const { plans, refusals } = plan({
    seeds,
    apps: positionals,
    size: values.size,
    target: values.target,
    today: values.today ?? deps.env.SEED_TODAY ?? localToday(),
    random: values.random ?? deps.env.SEED_RANDOM ?? DEFAULT_SEED_RANDOM,
    envUrl: deps.env.DATABASE_URL || undefined,
    databases,
    localPorts,
  });
  if (refusals.length) {
    for (const r of refusals) deps.log(`refused  ${r}`);
    deps.log(`nothing was seeded (${refusals.length} refusal(s))`);
    return 1;
  }

  let failed = 0;
  for (const p of plans) {
    const env: NodeJS.ProcessEnv = { ...deps.env };
    for (const [k, v] of Object.entries(p.env)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const began = Date.now();
    const r = await deps.exec("sh", ["-c", p.app.run], {
      cwd: deps.root,
      env,
      echo: true,
      timeoutMs: 1_800_000,
    });
    const took = formatDuration(Date.now() - began);
    const where = `size ${p.env.SEED_SIZE}  target ${p.env.SEED_TARGET}  ${p.database}`;
    if (r.code === 0) deps.log(`ok    ${p.app.app}  ${where}  ${took}`);
    else {
      failed++;
      deps.log(
        `FAIL  ${p.app.app}  ${where}  ${took}  (${r.timedOut ? "timed out" : r.notFound ? "sh not found" : `exit ${r.code}`})`,
      );
    }
  }
  return failed ? 1 : 0;
}

if (isEntry(import.meta.url)) {
  const root = findRoot();
  if (!root) {
    console.error("seed: no sdlc.config.json here or above — run it inside the repository");
    process.exit(2);
  }
  process.exitCode = await main(process.argv.slice(2), {
    root,
    config: await loadConfig(root),
    exec: realExec,
    log: console.log,
    env: process.env,
  });
}
