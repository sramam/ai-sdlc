/**
 * Rewrite the evidence index after every run — and **fail the run** if it
 * cannot.
 *
 * Teardown rather than a command to remember, because an index that has to be
 * remembered goes stale — and a stale index of *what is tested* reads as
 * coverage nobody has. A subprocess, so the index runs as the plain-node CLI it
 * is rather than inside Playwright's module transform.
 *
 * It used to warn on a failed regeneration, so Playwright exited 0 over an
 * index describing the previous run. A warning nobody reads is the silent
 * success principles §5 is about; throwing here is what Playwright turns into
 * a failed run.
 */
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { dirname } from "node:path";
import type { FullConfig } from "@playwright/test";
import { INDEX_CLI } from "../cli/paths.mts";
import { journeysRoot } from "../config.mts";

type Run = (root: string) => Pick<SpawnSyncReturns<Buffer>, "status" | "signal" | "error">;

const runIndex: Run = (root) =>
  spawnSync(process.execPath, [INDEX_CLI], { cwd: root, stdio: "inherit" });

/** Regenerate the index under `root`; throw `JOURNEY-070` on anything but exit 0. */
export function regenerateIndex(root: string, run: Run = runIndex): void {
  const result = run(root);
  if (result.status === 0) return;
  const how = result.error
    ? `could not start (${result.error.message})`
    : result.signal
      ? `was killed by ${result.signal}`
      : `exited ${result.status}`;
  throw new Error(
    `JOURNEY-070: the evidence index did not regenerate — \`journeys index\` ${how}. ` +
      "The committed index would describe an earlier run, so this run fails rather than pass over it.",
  );
}

export default function globalTeardown(full: FullConfig): void {
  regenerateIndex(journeysRoot(full.configFile ? dirname(full.configFile) : process.cwd()));
}
