/**
 * `pnpm db:local <command> [args] [--force]` — a PGlite database per checkout.
 *
 *   start [db]               start (all declared databases when db is omitted)
 *   stop [db]                stop
 *   status [db]              one line per database
 *   url [db]                 print DATABASE_URL; exit 1 when it is not running
 *   migrate [db]             snapshot pre-migrate-<time>, then run its migrate command
 *   reset [db] [--force]     snapshot, delete the data, start, migrate
 *   snapshot <label> [db]    dump the data directory to .localdb/<db>/snapshots/
 *   restore <label> [db]     put a snapshot back (--force stops and restarts a running one)
 *   snapshots [db]           list them
 *
 * Exit 0 when everything was ok, 1 on any definite failure, 3 when something
 * could not be asked and nothing failed outright.
 */
import { parseArgs } from "node:util";
import { isEntry } from "../../core/src/exec.mts";
import { findRoot, loadConfig } from "../../core/src/config.mts";
import type { LocaldbDatabase, SdlcConfig } from "../../core/src/config.mts";
import { validName } from "./lib.mts";
import * as ops from "./localdb.mts";
import type { Ctx, Outcome } from "./localdb.mts";

const USAGE = `usage: pnpm db:local <start|stop|status|url|migrate|reset|snapshot <label>|restore <label>|snapshots> [db] [--force]`;

/** Every-db commands act on all declared databases when none is named. */
const ALL_BY_DEFAULT = new Set(["start", "stop", "status", "snapshots"]);
const TAKES_LABEL = new Set(["snapshot", "restore"]);

export function exitCode(outcomes: Outcome[]): number {
  if (outcomes.includes("failed")) return 1;
  if (outcomes.includes("could-not-ask")) return 3;
  return 0;
}

export function selectDatabases(
  declared: LocaldbDatabase[],
  name: string | undefined,
  all: boolean,
): { dbs: LocaldbDatabase[] } | { error: string } {
  const names = declared.map((d) => d.name).join(", ");
  if (name !== undefined) {
    const hit = declared.find((d) => d.name === name);
    return hit
      ? { dbs: [hit] }
      : { error: `no database named ${JSON.stringify(name)} — declared: ${names}` };
  }
  if (all || declared.length === 1) return { dbs: declared };
  return { error: `name a database — declared: ${names}` };
}

export async function main(
  argv: string[],
  cfg: SdlcConfig,
  root: string,
  log = console.log,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { force: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) {
    log(USAGE);
    return cmd || values.help ? 0 : 2;
  }
  const known = [
    "start",
    "stop",
    "status",
    "url",
    "migrate",
    "reset",
    "snapshot",
    "restore",
    "snapshots",
  ];
  if (!known.includes(cmd)) {
    console.error(`unknown command ${JSON.stringify(cmd)}\n${USAGE}`);
    return 2;
  }
  const label = TAKES_LABEL.has(cmd) ? rest.shift() : undefined;
  if (TAKES_LABEL.has(cmd) && !label) {
    console.error(`${cmd} needs a label\n${USAGE}`);
    return 2;
  }

  const declared = cfg.localdb?.databases ?? [];
  if (!declared.length) {
    log(
      "no database declared — add localdb.databases to sdlc.config.json (see tooling/localdb/README.md)",
    );
    return cmd === "url" ? 1 : 0;
  }
  const bad = declared.filter((d) => !validName(d.name));
  if (bad.length) {
    console.error(
      `invalid database name(s) in sdlc.config.json: ${bad.map((d) => JSON.stringify(d.name)).join(", ")}`,
    );
    return 2;
  }
  const picked = selectDatabases(declared, rest[0], ALL_BY_DEFAULT.has(cmd));
  if ("error" in picked) {
    console.error(picked.error);
    return 2;
  }

  const ctx: Ctx = { root, log };
  const outcomes: Outcome[] = [];
  for (const db of picked.dbs) {
    switch (cmd) {
      case "start":
        outcomes.push(await ops.start(ctx, db));
        break;
      case "stop":
        outcomes.push(await ops.stop(ctx, db));
        break;
      case "status":
        outcomes.push(await ops.status(ctx, db));
        break;
      case "url":
        outcomes.push(await ops.url(ctx, db));
        break;
      case "migrate":
        outcomes.push(await ops.migrate(ctx, db));
        break;
      case "reset":
        outcomes.push(await ops.reset(ctx, db, { force: values.force }));
        break;
      case "snapshot":
        outcomes.push(await ops.snapshot(ctx, db, label!, { force: values.force }));
        break;
      case "restore":
        outcomes.push(await ops.restore(ctx, db, label!, { force: values.force }));
        break;
      case "snapshots":
        outcomes.push(ops.snapshots(ctx, db));
        break;
    }
  }
  return exitCode(outcomes);
}

if (isEntry(import.meta.url)) {
  const root = findRoot();
  if (!root) {
    console.error("db:local: no sdlc.config.json here or above — run it inside the repository");
    process.exit(2);
  }
  process.exitCode = await main(process.argv.slice(2), await loadConfig(root), root);
}
