/**
 * `pnpm usage [codeburn args…]` — AI usage for this repository, from the coding
 * agents' local logs, through codeburn (github.com/getagentseal/codeburn).
 *
 * codeburn is run with `pnpm dlx` at a pinned version rather than installed:
 * its dependencies (ink, react, an MCP SDK) are heavy for something a progress
 * report runs twice a week, and nothing imports it.
 *
 * Scope: `--project <main checkout>` is added unless the caller passed
 * `--project` or `--exact-project`. Given an absolute path, codeburn widens it
 * to every clone and worktree sharing that checkout's `origin` remote, past or
 * present, so the worktrees under `.claude/worktrees/` are counted with it.
 *
 * Network: codeburn fetches its price table once a day. Its Cursor sync is
 * turned off here (`CODEBURN_CURSOR_SYNC=0`), and its `sync`, `share` and
 * `devices` commands, which send usage elsewhere, are refused.
 *
 * The figures are API-equivalent cost at today's prices, from this machine's
 * logs only. Exit: codeburn's own; 1 for a refused command; 2 when the main
 * checkout could not be found.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { isEntry } from "./exec.mts";

export const CODEBURN = "codeburn@0.9.27";

/** codeburn commands that send usage off this machine. */
export const REFUSED = new Set(["sync", "share", "devices"]);

export type Plan = { ok: true; args: string[] } | { ok: false; reason: string };

/** The `pnpm dlx` arguments for a `pnpm usage` invocation. */
export function usageArgs(argv: string[], main: string): Plan {
  const command = argv.find((a) => !a.startsWith("-"));
  if (command && REFUSED.has(command))
    return {
      ok: false,
      reason: `\`codeburn ${command}\` sends usage off this machine; pnpm usage does not run it`,
    };
  const scoped = argv.some(
    (a) => a === "--project" || a.startsWith("--project=") || a === "--exact-project",
  );
  return {
    ok: true,
    args: [
      "dlx",
      CODEBURN,
      ...(argv.length ? argv : ["report"]),
      ...(scoped ? [] : ["--project", main]),
    ],
  };
}

function mainCheckout(): string | null {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  });
  return r.status === 0 ? dirname(resolve(r.stdout.trim())) : null;
}

if (isEntry(import.meta.url)) {
  const main = mainCheckout();
  if (!main) {
    console.error("usage: could not find the main checkout (not a git repository?)");
    process.exit(2);
  }
  const plan = usageArgs(process.argv.slice(2), main);
  if (!plan.ok) {
    console.error(`usage: ${plan.reason}`);
    process.exit(1);
  }
  const r = spawnSync("pnpm", plan.args, {
    stdio: "inherit",
    env: { ...process.env, CODEBURN_CURSOR_SYNC: "0" },
  });
  process.exit(r.status ?? 1);
}
