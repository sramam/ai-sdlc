/**
 * Load `.dev.vars` and `.env` into `process.env` for a script run from a shell.
 *
 * Both files are gitignored, so they exist in the main checkout and nowhere
 * else unless `pnpm bootstrap` has linked them. A worktree has its own
 * `sdlc.config.json`, so a loader that only walks up stops there, finds nothing,
 * and every script reports "X is not set" — which reads as a missing variable
 * rather than a loader looking in the wrong place (this once cost a seed run
 * and an integration run). So the main checkout is the fallback.
 *
 *   import { loadEnv } from "./load-env.mts";
 *   loadEnv();
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findRoot } from "../../core/src/config.mts";

export const ENV_FILES = [".dev.vars", ".env"] as const;

/**
 * Never taken from a file: a file's `NODE_ENV=development` silently changes how
 * every build behaves (#1465 — a "flaky" build that was really
 * "flaky" invocation).
 */
const NEVER_FROM_FILE = new Set(["NODE_ENV"]);

/** The main checkout's root, or null when git cannot say. Never a guess. */
export function mainCheckout(cwd: string = process.cwd()): string | null {
  try {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return common ? dirname(common) : null;
  } catch {
    return null;
  }
}

/** A minimal dotenv parser: KEY=VALUE, `export`, quotes, `#` comments. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    let value = m[2] ?? "";
    const q = value[0];
    if ((q === '"' || q === "'") && value.lastIndexOf(q) > 0) {
      value = value.slice(1, value.lastIndexOf(q));
      if (q === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[key] = value;
  }
  return out;
}

export interface LoadEnvOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests; defaults to asking git. */
  mainCheckout?: (cwd: string) => string | null;
  /** Load even under vitest. Only tests set this. */
  force?: boolean;
}

/**
 * Fills gaps, never overrides: a variable already set wins, then this
 * checkout's files, then the main checkout's. Returns the files it read.
 *
 * A no-op under vitest — the unit suite must not see a developer's secrets.
 */
export function loadEnv(opts: LoadEnvOptions = {}): string[] {
  const env = opts.env ?? process.env;
  if (env.VITEST && !opts.force) return [];
  const cwd = opts.cwd ?? process.cwd();
  const root = findRoot(cwd) ?? cwd;
  const dirs = [root];
  const main = (opts.mainCheckout ?? mainCheckout)(cwd);
  if (main && resolve(main) !== resolve(root)) dirs.push(main);

  const read: string[] = [];
  for (const dir of dirs) {
    for (const name of ENV_FILES) {
      const file = resolve(dir, name);
      if (!existsSync(file)) continue;
      read.push(file);
      for (const [k, v] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
        if (NEVER_FROM_FILE.has(k)) continue;
        if (env[k] === undefined) env[k] = v;
      }
    }
  }
  return read;
}
