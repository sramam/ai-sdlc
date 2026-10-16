/**
 * `pnpm rollback <env>` — run the environment's configured rollback command.
 *
 * It moves the **code** back and nothing else. The schema stays forward
 * (docs/kit/environments.md § Deploying): a migration is never undone by a
 * rollback, which is why migrations are additive first — a column is
 * deprecated in one release and dropped a release or more later. The git
 * branch is not moved either, so after a rollback the branch names a newer
 * commit than the environment runs, until the next promotion.
 *
 * Exit 0 rolled back · 1 refused or failed · 2 could not ask.
 */
import { exec as realExec, isEntry } from "../../core/src/exec.mts";
import type { Exec } from "../../core/src/exec.mts";
import { findRoot, loadConfig as realLoadConfig } from "../../core/src/config.mts";
import type { SdlcConfig } from "../../core/src/config.mts";
import { exitFor, reporter } from "./shared.mts";
import type { LineState } from "./shared.mts";

export interface RollbackDeps {
  exec: Exec;
  root: string;
  loadConfig: (dir: string) => Promise<SdlcConfig>;
  log: (line: string) => void;
}

const USAGE = "usage: pnpm rollback <env>";

export const SCHEMA_STAYS_FORWARD =
  "The schema stays forward: a rollback moves the code back and undoes no migration. The previous code must work against today's schema — which is why migrations are additive first (docs/kit/environments.md).";

export function parseRollbackArgs(argv: string[]): { env: string } | { error: string } {
  const args = argv.filter((a) => a !== "--");
  const bad = args.find((a) => a.startsWith("--"));
  if (bad) return { error: `unknown argument: ${bad}\n${USAGE}` };
  if (args.length !== 1 || !args[0]) return { error: USAGE };
  return { env: args[0] };
}

export async function runRollback(envName: string, deps: RollbackDeps): Promise<number> {
  const line = reporter(deps.log);
  const stop = (name: string, state: LineState, text: string) => {
    line(name, state, text);
    return exitFor(state);
  };
  const config = await deps.loadConfig(deps.root);
  const env = config.environments?.[envName];
  if (!env) return stop("config", "REFUSED", `no environment "${envName}" in sdlc.config.json`);
  if (!env.rollback)
    return stop(
      "config",
      "REFUSED",
      `environments.${envName}.rollback is not configured — nothing to run (tooling/promote/README.md)`,
    );
  deps.log(`rollback ${envName}: ${env.rollback}`);
  deps.log(`  ${SCHEMA_STAYS_FORWARD}`);
  const r = await deps.exec("sh", ["-c", env.rollback], {
    cwd: deps.root,
    timeoutMs: 900_000,
    echo: true,
    env: { ...process.env, PROMOTE_ENV: envName, PROMOTE_BRANCH: env.branch },
  });
  if (r.code !== 0)
    return stop(
      "rollback",
      r.notFound || r.timedOut ? "COULD NOT ASK" : "FAILED",
      `\`${env.rollback}\` exited ${r.code ?? "on a signal"}${r.timedOut ? " (timed out)" : ""} — ${envName} may still run the version being rolled back`,
    );
  line("rollback", "ok", env.rollback);
  deps.log("");
  deps.log(
    `rollback: ${envName} runs the previous version. The schema is unchanged, and ${env.branch} still names the newer commit until the next promotion.`,
  );
  return 0;
}

async function main(): Promise<void> {
  const a = parseRollbackArgs(process.argv.slice(2));
  if ("error" in a) {
    console.error(a.error);
    process.exit(1);
  }
  const root = findRoot();
  if (!root) {
    console.error("rollback: no sdlc.config.json above this directory");
    process.exit(1);
  }
  process.exit(
    await runRollback(a.env, {
      exec: realExec,
      root,
      loadConfig: realLoadConfig,
      log: (l) => console.log(l),
    }),
  );
}

if (isEntry(import.meta.url)) await main();
