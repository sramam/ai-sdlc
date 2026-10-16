/**
 * Running `playwright test` from a CLI, without `pnpm exec`.
 *
 * **The project's Playwright, else this package's.** Two copies of
 * `@playwright/test` in one run is an error Playwright raises itself, and the
 * fixtures here import this package's — so in a workspace where the two are the
 * same install (the usual case), either resolves to one module.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";

export function playwrightCli(root: string): string {
  for (const from of [join(root, "noop.cjs"), import.meta.url]) {
    try {
      return createRequire(from).resolve("@playwright/test/cli");
    } catch {
      // Try the next.
    }
  }
  throw new Error(
    "JOURNEY-061: @playwright/test is not installed — it is a peer dependency of @ai-sdlc/journeys",
  );
}

/** `playwright test --config <config> …args`; the exit status, never `null`. */
export function runPlaywright(
  root: string,
  configFile: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): number {
  const config = isAbsolute(configFile) ? configFile : join(root, configFile);
  const result = spawnSync(
    process.execPath,
    [playwrightCli(root), "test", "--config", config, ...args],
    {
      cwd: root,
      stdio: "inherit",
      env,
    },
  );
  // `process.exit(null)` exits 0: a child dead on a signal must not read as green.
  return result.status ?? 1;
}
