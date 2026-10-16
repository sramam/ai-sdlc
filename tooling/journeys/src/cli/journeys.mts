#!/usr/bin/env node
/**
 * `journeys <command>` — one entry point over the package's CLIs.
 *
 * | command | |
 * | --- | --- |
 * | `learn` | record three passes over one stack; only the third gates |
 * | `test` | one comparison pass; never learns |
 * | `delta` | what a re-record changed against a ref (`--report` for the images) |
 * | `drift` | which journeys photograph a route this branch changed |
 * | `index` | regenerate the evidence index and status lines from disk |
 * | `timing` | re-record journeys one at a time, measuring each |
 * | `stack` | run the app under test until signalled |
 *
 * **Each command runs as its own `node …/cli/<name>.mts` process**, not
 * in-process, so its command line names it: the load gate finds a recording in
 * another checkout with `pgrep -f`, and `journeys learn` has to look like one.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const COMMANDS: Record<string, string> = {
  learn: "learn",
  test: "run",
  delta: "delta",
  drift: "drift",
  index: "index",
  timing: "timing",
  stack: "stack",
};

const [command, ...rest] = process.argv.slice(2);
const target = command ? COMMANDS[command] : undefined;
if (!target) {
  console.error(`usage: journeys <${Object.keys(COMMANDS).join("|")}> [args]`);
  process.exit(command ? 1 : 0);
}
const file = fileURLToPath(new URL(`./${target}.mts`, import.meta.url));
const result = spawnSync(process.execPath, [file, ...rest], { stdio: "inherit" });
process.exit(result.status ?? 1);
